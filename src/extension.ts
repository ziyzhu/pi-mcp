import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { attachedCapabilities, bridgeDirectory, maximumFrame, messagePage, privateDirectory, type BridgeMetadata } from "./bridge.ts";

const requestSchema = z.object({
  id: z.uuid(), runtimeId: z.uuid(), sessionId: z.string(),
  type: z.enum(["snapshot", "send"]), commandId: z.uuid().optional(),
  message: z.string().min(1).max(100_000).optional(),
  intent: z.enum(["prompt", "steer", "follow_up"]).optional(),
  before: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).optional(),
});
type Command = { commandId: string; intent: string; status: "dispatched" | "input_observed" | "message_recorded"; dispatchedAt: string };
type RunningBridge = {
  metadata: BridgeMetadata; context: ExtensionContext; server: Server; sockets: Set<Socket>;
  revision: number; latestEvent?: { type: string }; partialText: string; publication: Promise<void>;
  commands: Map<string, { signature: string; result: { disposition: string; commandId: string } }>;
  recent: Command[]; pending: { command: Command; message: string }[];
};

export default function (pi: ExtensionAPI): void {
  const directory = bridgeDirectory();
  let bridge: RunningBridge | undefined;

  function publish(current: RunningBridge): Promise<void> {
    current.publication = current.publication.then(async () => {
      if (bridge !== current) return;
      const path = join(directory, `${current.metadata.runtimeId}.json`);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(current.metadata) + "\n", { mode: 0o600 });
      await rename(temporary, path);
    });
    return current.publication;
  }

  async function stop(): Promise<void> {
    const current = bridge;
    bridge = undefined;
    if (!current) return;
    current.context.ui.setStatus("pi-mcp", undefined);
    for (const socket of current.sockets) socket.destroy();
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
    await current.publication.catch(() => {});
    await Promise.all(["json", "json.tmp", "sock"].map((suffix) => rm(join(directory, `${current.metadata.runtimeId}.${suffix}`), { force: true })));
  }

  function handle(current: RunningBridge, input: unknown): unknown {
    const request = requestSchema.parse(input);
    if (bridge !== current || request.runtimeId !== current.metadata.runtimeId || request.sessionId !== current.context.sessionManager.getSessionId()) throw new Error("Stale runtimeId or sessionId; read the session again");
    if (request.type === "snapshot") {
      const ctx = current.context;
      return {
        ...current.metadata, running: true, ownership: "attached", capabilities: attachedCapabilities,
        revision: current.revision, latestEvent: current.latestEvent, partialText: current.partialText,
        state: { sessionId: request.sessionId, sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: ctx.thinkingLevel, isStreaming: !ctx.isIdle(), hasPendingMessages: ctx.hasPendingMessages() },
        ...messagePage(ctx.sessionManager.buildSessionProjection().messages, request.before, request.limit),
        interactions: [], recentCommands: current.recent,
      };
    }
    const { commandId, message, intent } = request;
    if (!commandId || !message || !intent) throw new Error("Sending requires commandId, message, and intent");
    const signature = createHash("sha256").update(JSON.stringify({ message, intent })).digest("hex");
    const cached = current.commands.get(commandId);
    if (cached) {
      if (cached.signature !== signature) throw new Error("commandId was reused with different input");
      return cached.result;
    }
    if (current.commands.size >= 10_000) throw new Error("Bridge deduplication capacity reached; reload locally before further mutations");
    if (intent === "prompt" && !current.context.isIdle()) throw new Error("Pi is busy; use steer or follow_up");
    const command: Command = { commandId, intent, status: "dispatched", dispatchedAt: new Date().toISOString() };
    const result = { disposition: "dispatched", commandId };
    current.commands.set(commandId, { signature, result });
    current.recent.push(command);
    if (current.recent.length > 100) current.recent.shift();
    current.pending.push({ command, message });
    if (current.pending.length > 100) current.pending.shift();
    current.context.ui.notify(`pi-mcp: remote ${intent.replaceAll("_", " ")}`, "info");
    pi.sendUserMessage(message, intent === "prompt" ? undefined : { deliverAs: intent === "steer" ? "steer" : "followUp" });
    return result;
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    await stop();
    if (process.env.PI_MCP_MANAGED === "1" || process.env.PI_MCP_BRIDGE_DISABLED === "1" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    await privateDirectory(directory);
    const runtimeId = randomUUID();
    const path = join(directory, `${runtimeId}.sock`);
    if (Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107)) throw new Error("Bridge socket path is too long; set PI_MCP_BRIDGE_DIR to a shorter private directory");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      if (!bridge || sockets.size >= 32) { socket.destroy(); return; }
      const current = bridge;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(5000, () => socket.destroy());
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input) > maximumFrame) { socket.destroy(); return; }
        const end = input.indexOf("\n");
        if (end < 0) return;
        socket.removeAllListeners("data");
        let id: unknown;
        try {
          const request = JSON.parse(input.slice(0, end));
          id = request.id;
          const data = handle(current, request);
          socket.end(JSON.stringify({ id, success: true, data }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ id, success: false, error: (error as Error).message }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    bridge = {
      metadata: { version: 1, runtimeId, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(), name: pi.getSessionName(), pid: process.pid, mode: ctx.mode },
      context: ctx, server, sockets, revision: 0, partialText: "", publication: Promise.resolve(), commands: new Map(), recent: [], pending: [],
    };
    try {
      await chmod(path, 0o600);
      await publish(bridge);
      ctx.ui.setStatus("pi-mcp", "pi-mcp: remote access enabled");
    } catch (error) { await stop(); throw error; }
  }

  pi.on("session_start", async (_, ctx) => { await start(ctx); });
  pi.on("session_shutdown", async () => { await stop(); });
  pi.on("session_info_changed", async () => {
    if (!bridge) return;
    bridge.metadata.name = pi.getSessionName();
    await publish(bridge);
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") return;
    const pending = bridge?.pending.find((item) => item.command.status === "dispatched" && item.message === event.text);
    if (pending) pending.command.status = "input_observed";
  });
  pi.on("message_start", (event) => {
    if (!bridge) return;
    if (event.message.role === "assistant") bridge.partialText = "";
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const index = bridge.pending.findIndex((item) => item.message === text);
    if (index >= 0) bridge.pending.splice(index, 1)[0]!.command.status = "message_recorded";
  });
  pi.on("message_update", (event) => {
    if (bridge && event.assistantMessageEvent.type === "text_delta") bridge.partialText = (bridge.partialText + event.assistantMessageEvent.delta).slice(-32_768);
  });
  const recordActivity = (event: { type: string }) => {
    if (!bridge) return;
    bridge.revision++;
    bridge.latestEvent = { type: event.type };
  };
  pi.on("agent_start", recordActivity);
  pi.on("agent_settled", recordActivity);
  pi.on("message_start", recordActivity);
  pi.on("message_update", recordActivity);
  pi.on("message_end", recordActivity);
  pi.on("tool_execution_start", recordActivity);
  pi.on("tool_execution_end", recordActivity);
  pi.on("session_tree", recordActivity);
  pi.on("session_compact", recordActivity);
  pi.registerCommand("pi-mcp", {
    description: "Enable or disable local pi-mcp remote access: /pi-mcp on|off|status",
    handler: async (args, ctx) => {
      if (args.trim() === "off") { process.env.PI_MCP_BRIDGE_DISABLED = "1"; await stop(); }
      else if (args.trim() === "on") { delete process.env.PI_MCP_BRIDGE_DISABLED; await start(ctx); }
      ctx.ui.notify(bridge ? "pi-mcp remote access enabled; trusted local/MCP callers can send messages. /pi-mcp off disables it." : "pi-mcp remote access disabled. /pi-mcp on enables it.", "info");
    },
  });
}

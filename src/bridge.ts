import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const bridgeDirectory = () => process.env.PI_MCP_BRIDGE_DIR ?? join(homedir(), ".pi-mcp", "bridges");
export const bridgeMetadata = z.object({
  version: z.literal(1), runtimeId: z.uuid(), sessionId: z.string().min(1).max(200),
  cwd: z.string(), sessionFile: z.string().optional(), name: z.string().optional(),
  pid: z.number().int().positive(), mode: z.enum(["tui", "rpc"]),
});
export type BridgeMetadata = z.infer<typeof bridgeMetadata>;
export const attachedCapabilities = { read: true, send: true, steer: true, followUp: true, stop: false, interactions: false, fork: false };
export const managedCapabilities = { ...attachedCapabilities, stop: true, interactions: true };
export const savedCapabilities = { read: true, send: false, steer: false, followUp: false, stop: false, interactions: false, fork: true };
export const maximumFrame = 8 * 1024 * 1024;

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Bridge directory must be owned by this user and private (mode 0700)");
}

export async function discoverBridges(directory: string): Promise<BridgeMetadata[]> {
  await privateDirectory(directory);
  const bridges: BridgeMetadata[] = [];
  for (const entry of await readdir(directory)) {
    const id = entry.replace(/\.json$/, "");
    if (!entry.endsWith(".json") || !z.uuid().safeParse(id).success) continue;
    try {
      const path = join(directory, entry);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 65_536 || info.uid !== process.getuid?.() || (info.mode & 0o077)) continue;
      const metadata = bridgeMetadata.parse(JSON.parse(await readFile(path, "utf8")));
      if (metadata.runtimeId === id) bridges.push(metadata);
    } catch {}
  }
  return bridges;
}

export function bridgeRequest(directory: string, metadata: BridgeMetadata, type: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(join(directory, `${metadata.runtimeId}.sock`));
    let input = "";
    const timer = setTimeout(() => fail(new Error(`Bridge ${type} timed out; delivery may be unknown. Do not blindly resend mutations.`)), 5000);
    function fail(error: Error) { clearTimeout(timer); socket.destroy(); reject(error); }
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("Pi bridge disconnected; delivery may be unknown")));
    socket.on("connect", () => socket.write(JSON.stringify({ ...params, id, type, runtimeId: metadata.runtimeId, sessionId: metadata.sessionId }) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > maximumFrame) { fail(new Error("Pi bridge response exceeded frame limit")); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(input.slice(0, end));
        if (response.id !== id) throw new Error("Pi bridge response identity mismatch");
        clearTimeout(timer);
        socket.destroy();
        if (response.success) resolve(response.data);
        else reject(new Error(response.error ?? "Pi bridge request failed"));
      } catch (error) { fail(error as Error); }
    });
  });
}

export function messagePage(messages: unknown[], before?: number, limit = 10): { messages: unknown[]; before: number | null } {
  const end = Math.min(before ?? messages.length, messages.length);
  const start = Math.max(0, end - Math.min(limit, 20));
  return {
    messages: messages.slice(start, end).map((message) => {
      const text = JSON.stringify(message);
      return text.length <= 32_768 ? message : { truncated: true, preview: text.slice(0, 32_768) };
    }),
    before: start || null,
  };
}

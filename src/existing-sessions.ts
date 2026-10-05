import { SessionManager, buildSessionContext, migrateSessionEntries, parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { diagnostic } from "./diagnostics.ts";
import { attachedCapabilities, bridgeDirectory, bridgeRequest, discoverBridges, messagePage, savedCapabilities, type BridgeMetadata } from "./bridge.ts";

export type DiscoveryOptions = { bridgeDirectory?: string; sessionDirectory?: string };
type ExistingSession = { sessionId: string; bridge?: BridgeMetadata; snapshot?: any; saved?: SessionInfo };

export function contains(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(difference);
}

export class ExistingSessions {
  private readonly bridgeDirectory: string;
  private readonly sessionDirectory: string;
  private readonly unavailable = new Set<string>();

  constructor(private readonly allowedRoot: string, options: DiscoveryOptions = {}) {
    this.bridgeDirectory = options.bridgeDirectory ?? bridgeDirectory();
    this.sessionDirectory = options.sessionDirectory ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
  }

  private async scoped(cwd: string): Promise<boolean> {
    try { return contains(this.allowedRoot, await realpath(cwd)); } catch { return false; }
  }

  private async live(id?: string, before?: number, limit = 1): Promise<ExistingSession[]> {
    const entries: ExistingSession[] = [];
    await Promise.all((await discoverBridges(this.bridgeDirectory)).map(async (metadata) => {
      if ((id && metadata.sessionId !== id) || !await this.scoped(metadata.cwd)) return;
      try {
        const snapshot = await bridgeRequest(this.bridgeDirectory, metadata, "snapshot", { before, limit });
        if (snapshot.sessionId !== metadata.sessionId || snapshot.runtimeId !== metadata.runtimeId) throw new Error("Bridge snapshot identity mismatch");
        if (this.unavailable.delete(metadata.runtimeId)) diagnostic("bridge_recovered", { sessionId: metadata.sessionId, runtimeId: metadata.runtimeId });
        entries.push({ sessionId: metadata.sessionId, bridge: metadata, snapshot });
      } catch (error) {
        if (!this.unavailable.has(metadata.runtimeId)) diagnostic("bridge_unavailable", { sessionId: metadata.sessionId, runtimeId: metadata.runtimeId, reason: (error as Error).message });
        this.unavailable.add(metadata.runtimeId);
      }
    }));
    return entries;
  }

  private async saved(): Promise<SessionInfo[]> {
    const root = await realpath(this.sessionDirectory).catch(() => undefined);
    if (!root) return [];
    const directories = [root];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      directories.push(join(root, entry.name));
    }
    const entries = (await Promise.all(directories.map((directory) => SessionManager.listAll(directory)))).flat();
    const scoped: SessionInfo[] = [];
    for (const entry of entries) {
      if (!await this.scoped(entry.cwd)) continue;
      const path = await realpath(entry.path).catch(() => undefined);
      if (path && contains(root, path)) scoped.push({ ...entry, path });
    }
    return scoped;
  }

  private async discover(): Promise<Map<string, ExistingSession>> {
    const found = new Map<string, ExistingSession>();
    const ambiguous = new Set<string>();
    const add = (id: string, entry: ExistingSession, kind: "bridge" | "saved") => {
      const existing = found.get(id);
      if (existing?.[kind]) { ambiguous.add(id); return; }
      found.set(id, { ...existing, ...entry });
    };
    for (const entry of await this.live()) add(entry.sessionId, entry, "bridge");
    for (const saved of await this.saved()) add(saved.id, { sessionId: saved.id, saved }, "saved");
    for (const id of ambiguous) found.delete(id);
    return found;
  }

  async attached(id: string, before?: number, limit = 10): Promise<any | undefined> {
    const entries = await this.live(id, before, limit);
    if (entries.length > 1) throw new Error("Ambiguous session: more than one Pi process owns this sessionId");
    return entries[0]?.snapshot;
  }

  async list(): Promise<unknown[]> {
    return [...(await this.discover()).values()].map((entry) => {
      if (entry.bridge) {
        const { bridge, snapshot } = entry;
        return { sessionId: entry.sessionId, runtimeId: bridge.runtimeId, cwd: bridge.cwd, name: bridge.name, model: snapshot.state.model, running: true, ownership: "attached", status: snapshot.state.isStreaming ? "working" : "idle", capabilities: attachedCapabilities };
      }
      const saved = entry.saved!;
      return { sessionId: entry.sessionId, cwd: saved.cwd, name: saved.name, modified: saved.modified, running: null, ownership: "saved", status: "ownership_unknown", capabilities: savedCapabilities };
    });
  }

  private async get(id: string): Promise<ExistingSession> {
    const live = await this.live(id);
    if (live.length === 1) return live[0]!;
    if (live.length > 1) throw new Error("Ambiguous session: more than one Pi process owns this sessionId");
    const saved = (await this.saved()).filter((entry) => entry.id === id);
    if (saved.length !== 1) throw new Error("Unknown, ambiguous, disconnected, or out-of-scope Pi session");
    return { sessionId: id, saved: saved[0] };
  }

  async read(id: string, before?: number, limit = 10): Promise<any> {
    const entry = await this.get(id);
    if (entry.bridge) return bridgeRequest(this.bridgeDirectory, entry.bridge, "snapshot", { before, limit });
    const saved = entry.saved!;
    const entries = parseSessionEntries(await readFile(saved.path, "utf8"));
    migrateSessionEntries(entries);
    const context = buildSessionContext(entries.filter((entry) => entry.type !== "session"));
    return {
      sessionId: id, running: null, ownership: "saved", status: "ownership_unknown", capabilities: savedCapabilities,
      state: { model: context.model, thinkingLevel: context.thinkingLevel, sessionFile: saved.path },
      ...messagePage(context.messages, before, limit), interactions: [],
    };
  }

  async resume(id: string): Promise<unknown> {
    const snapshot = await this.read(id, undefined, 1);
    if (snapshot.ownership !== "attached") throw new Error("Live ownership is unknown. Use fork_session to create a separate managed copy, or load the bridge in the existing Pi process");
    return snapshot;
  }

  async source(id: string): Promise<SessionInfo> {
    const entry = await this.get(id);
    if (entry.bridge) throw new Error("Fork a live attached session locally with /fork; fork_session only copies saved history");
    return entry.saved!;
  }

  async runtime(id: string, runtimeId: string, commandId: string, operation: string) {
    const entry = await this.get(id);
    const bridge = entry.bridge;
    if (!bridge || bridge.runtimeId !== runtimeId) throw new Error("Stale runtimeId or disconnected Pi bridge; read the session again");
    if (operation !== "send") throw new Error("Attached sessions do not support queue-clearing stop or remote dialogs; use the terminal");
    return {
      id: runtimeId,
      request: async (type: string, params: Record<string, unknown> = {}) => {
        if (!["prompt", "steer", "follow_up"].includes(type)) throw new Error("Unsupported attached-session operation");
        return bridgeRequest(this.bridgeDirectory, bridge, "send", { ...params, commandId, intent: type });
      },
      respond: async () => { throw new Error("Answer attached-session dialogs in the terminal"); },
    };
  }
}

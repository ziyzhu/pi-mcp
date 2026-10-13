import { SessionManager, buildSessionContext, migrateSessionEntries, parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { messagePage, savedCapabilities } from "./presentation.ts";

export function contains(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(difference);
}

export class SavedSessions {
  private readonly sessionDirectory: string;

  constructor(private readonly allowedRoot: string, sessionDirectory?: string) {
    this.sessionDirectory = sessionDirectory ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
  }

  private async scoped(cwd: string): Promise<boolean> {
    try { return contains(this.allowedRoot, await realpath(cwd)); } catch { return false; }
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

  async list(): Promise<unknown[]> {
    const saved = await this.saved();
    const counts = new Map<string, number>();
    for (const entry of saved) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    return saved.filter((entry) => counts.get(entry.id) === 1).map((entry) => ({
      sessionId: entry.id, cwd: entry.cwd, name: entry.name, modified: entry.modified,
      running: null, ownership: "saved", status: "ownership_unknown", capabilities: savedCapabilities,
    }));
  }

  async source(id: string): Promise<SessionInfo> {
    const saved = (await this.saved()).filter((entry) => entry.id === id);
    if (saved.length !== 1) throw new Error("Unknown, ambiguous, or out-of-scope saved Pi session");
    return saved[0]!;
  }

  async read(id: string, before?: number, limit = 10): Promise<unknown> {
    const saved = await this.source(id);
    const entries = parseSessionEntries(await readFile(saved.path, "utf8"));
    migrateSessionEntries(entries);
    const context = buildSessionContext(entries.filter((entry) => entry.type !== "session"));
    return {
      sessionId: id, running: null, ownership: "saved", status: "ownership_unknown", capabilities: savedCapabilities,
      state: { model: context.model, thinkingLevel: context.thinkingLevel, sessionFile: saved.path },
      ...messagePage(context.messages, before, limit), interactions: [],
    };
  }
}

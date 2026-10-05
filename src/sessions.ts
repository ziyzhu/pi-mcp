import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { PiRuntime } from "./pi-runtime.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contains, ExistingSessions, type DiscoveryOptions } from "./existing-sessions.ts";
import { managedCapabilities, messagePage } from "./bridge.ts";
import { diagnostic } from "./diagnostics.ts";
export { diagnostic } from "./diagnostics.ts";

const metadata = z.object({
  version: z.literal(1), id: z.uuid(), cwd: z.string(), name: z.string().optional(),
  model: z.object({ provider: z.string(), id: z.string() }).optional(),
});
type Session = z.infer<typeof metadata>;
type LiveSession = { metadata: Session; runtime?: PiRuntime; starting?: Promise<PiRuntime>; tail: Promise<unknown> };

export class Sessions {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly commands = new Map<string, { signature: string; result: Promise<unknown> }>();
  private closing = false;

  private readonly existing: ExistingSessions;

  constructor(private readonly directory: string, private readonly allowedRoot: string, private readonly executable: string, discovery: DiscoveryOptions = {}) {
    this.existing = new ExistingSessions(allowedRoot, discovery);
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      const session = metadata.parse(JSON.parse(await readFile(join(this.directory, entry.name, "session.json"), "utf8")));
      if (session.id !== entry.name) throw new Error("Session directory identity mismatch");
      this.sessions.set(session.id, { metadata: session, tail: Promise.resolve() });
    }
  }

  private get(id: string): LiveSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown managed session");
    return session;
  }

  private async validateCwd(cwd: string): Promise<string> {
    const resolved = await realpath(cwd);
    if (!contains(this.allowedRoot, resolved)) throw new Error("Working directory is outside the allowed root");
    if (!(await stat(resolved)).isDirectory()) throw new Error("Working directory must be a directory");
    return resolved;
  }

  async list(): Promise<unknown[]> {
    const managed = [...this.sessions.values()].map(({ metadata: session, runtime }) => ({
      sessionId: session.id, cwd: session.cwd, name: session.name, model: session.model,
      running: runtime?.alive ?? false, runtimeId: runtime?.alive ? runtime.id : undefined,
      ownership: "managed", capabilities: managedCapabilities,
      status: !runtime?.alive ? "saved" : runtime.pendingInteractions().length ? "blocked" : runtime.working ? "working" : "idle",
    }));
    const existing = await this.existing.list() as { sessionId: string; ownership: string }[];
    const attached = new Set(existing.filter((entry) => entry.ownership === "attached").map((entry) => entry.sessionId));
    if (managed.some((entry) => entry.running && attached.has(entry.sessionId))) throw new Error("More than one Pi runtime owns a managed session; resolve the duplicate locally");
    return [...managed.filter((entry) => !attached.has(entry.sessionId)), ...existing.filter((entry) => entry.ownership === "attached" || !this.sessions.has(entry.sessionId))];
  }

  async fork(id: string, name?: string): Promise<unknown> {
    const source = await this.existing.source(id);
    return this.create({ cwd: source.cwd, name: name ?? source.name }, source.path);
  }

  async create(input: { cwd: string; name?: string; model?: { provider: string; id: string } }, source?: string): Promise<unknown> {
    if (this.closing) throw new Error("Server is shutting down");
    const cwd = await this.validateCwd(input.cwd);
    const session: Session = { version: 1, ...input, cwd, id: randomUUID() };
    const directory = join(this.directory, session.id);
    await mkdir(directory, { mode: 0o700 });
    if (source) SessionManager.forkFrom(source, cwd, join(directory, "pi"), { id: session.id });
    const temporary = join(directory, "session.json.tmp");
    await writeFile(temporary, JSON.stringify(session) + "\n", { mode: 0o600 });
    await rename(temporary, join(directory, "session.json"));
    this.sessions.set(session.id, { metadata: session, tail: Promise.resolve() });
    try { return await this.resume(session.id); }
    catch (error) { throw new Error(`Session ${session.id} was saved but could not start: ${(error as Error).message}`); }
  }

  async resume(id: string): Promise<unknown> {
    const attached = await this.existing.attached(id);
    if (attached) {
      if (this.sessions.get(id)?.runtime?.alive) throw new Error("More than one Pi runtime owns this session; resolve the duplicate locally");
      return attached;
    }
    if (!this.sessions.has(id)) return this.existing.resume(id);
    const session = this.get(id);
    const runtime = await this.start(session);
    return { sessionId: id, runtimeId: runtime.id, state: await runtime.request("get_state") };
  }

  private async start(session: LiveSession): Promise<PiRuntime> {
    if (this.closing) throw new Error("Server is shutting down");
    if (session.runtime?.alive) return session.runtime;
    if (session.starting) return session.starting;
    if ([...this.sessions.values()].filter((item) => item.runtime?.alive || item.starting).length >= 16) throw new Error("Maximum 16 active sessions reached");
    session.starting = this.launch(session);
    try { return await session.starting; }
    finally { session.starting = undefined; }
  }

  private async launch(session: LiveSession): Promise<PiRuntime> {
    const { id, cwd, name, model } = session.metadata;
    await this.validateCwd(cwd);
    const args = ["--session-dir", join(this.directory, id, "pi"), "--session-id", id];
    if (name) args.push("--name", name);
    if (model) args.push("--provider", model.provider, "--model", model.id);
    const runtime = new PiRuntime(this.executable, cwd, args, (code, signal) => {
      diagnostic("process_exit", { sessionId: id, code, signal });
    });
    session.runtime = runtime;
    try {
      await runtime.request("get_state");
      diagnostic("process_ready", { sessionId: id, runtimeId: runtime.id });
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }

  async read(id: string, before?: number, limit = 10): Promise<unknown> {
    const attached = await this.existing.attached(id, before, limit);
    if (attached) {
      if (this.sessions.get(id)?.runtime?.alive) throw new Error("More than one Pi runtime owns this session; resolve the duplicate locally");
      return attached;
    }
    if (!this.sessions.has(id)) return this.existing.read(id, before, limit);
    const session = this.get(id);
    if (!session.runtime?.alive) return { sessionId: id, running: false, resumeRequired: true };
    const runtime = session.runtime;
    const state = await runtime.request("get_state");
    const { messages } = await runtime.request("get_messages");
    const latest = JSON.stringify(runtime.latestEvent ?? null);
    return {
      sessionId: id, runtimeId: runtime.id, running: true, ownership: "managed", capabilities: managedCapabilities, revision: runtime.revision, state,
      ...messagePage(messages, before, limit), interactions: runtime.pendingInteractions(),
      latestEvent: latest.length <= 32_768 ? runtime.latestEvent : { truncated: true },
    };
  }

  mutate(id: string, runtimeId: string, commandId: string, operation: string, input: unknown, fn: (runtime: { id: string; request: PiRuntime["request"]; respond: PiRuntime["respond"] }) => Promise<unknown>): Promise<unknown> {
    const key = `${id}:${commandId}`;
    const signature = createHash("sha256").update(JSON.stringify({ runtimeId, operation, input })).digest("hex");
    const cached = this.commands.get(key);
    if (cached) {
      if (cached.signature !== signature) return Promise.reject(new Error("commandId was reused with different input"));
      return cached.result;
    }
    if (this.commands.size >= 10_000) return Promise.reject(new Error("Command deduplication capacity reached; restart the server before further mutations"));
    const session = this.sessions.get(id);
    const predecessor = operation === "interaction" ? Promise.resolve() : session?.tail.catch(() => {}) ?? Promise.resolve();
    const result = predecessor.then(async () => {
      if (this.closing) throw new Error("Server is shutting down");
      const attached = await this.existing.attached(id, undefined, 1);
      if (attached && session?.runtime?.alive) throw new Error("More than one Pi runtime owns this session; resolve the duplicate locally");
      if (!attached && session && !session.runtime?.alive) throw new Error("Session is not running; resume it first");
      const runtime = attached || !session ? await this.existing.runtime(id, runtimeId, commandId, operation) : session.runtime!;
      if (runtime.id !== runtimeId) throw new Error("Stale runtimeId; read the session again");
      diagnostic("command", { sessionId: id, commandId, operation });
      try {
        const value = await fn(runtime);
        const dispatched = typeof value === "object" && value !== null && "disposition" in value && value.disposition === "dispatched";
        diagnostic(dispatched ? "command_dispatched" : "command_accepted", { sessionId: id, commandId, operation });
        return value;
      } catch (error) {
        diagnostic("command_failed", { sessionId: id, commandId, operation });
        throw error;
      }
    });
    if (session && operation !== "interaction") session.tail = result;
    this.commands.set(key, { signature, result });
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      await session.starting?.catch(() => {});
      await session.runtime?.close();
    }));
  }
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import { bridgeRequest, discoverBridges } from "../src/bridge.ts";

const directory = await realpath(await mkdtemp("/tmp/pi-mcp-attach-"));
const workspace = join(directory, "workspace");
const registry = join(directory, "bridges");
const agent = join(directory, "agent");
const sessionRoot = join(agent, "sessions");
const extension = resolve(import.meta.dir, "../src/extension.ts");
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until<T>(probe: () => Promise<T | undefined>, description: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${description}; Pi diagnostics: ${diagnostics}`);
}
const requests: string[] = [];
const model = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const content = body.messages.findLast((message) => message.role === "user")?.content ?? "";
    const text = typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
    requests.push(text);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (delta: unknown, finish: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
        send({ role: "assistant", content: "REPLY:" });
        await Bun.sleep(text === "slow" ? 1500 : 100);
        send({ content: text });
        send({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
await mkdir(workspace, { recursive: true });
await mkdir(agent, { recursive: true });
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100 }] } } }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ autoCompaction: false, autoRetry: false }));
const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", extension, "--provider", "fixture", "--model", "fixture", "--name", "Already running Pi"], {
  cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_MCP_BRIDGE_DIR: registry, PI_MCP_MANAGED: "0" }, stdio: "pipe",
});
let diagnostics = "";
child.stderr.on("data", (chunk) => { diagnostics += chunk; });
const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
let output = "";
const pending = new Map<string, (record: any) => void>();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  output += chunk;
  let end: number;
  while ((end = output.indexOf("\n")) >= 0) {
    const line = output.slice(0, end);
    output = output.slice(end + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "response") pending.get(record.id)?.(record);
    else if (record.type.includes("error")) diagnostics += JSON.stringify(record);
  }
});
async function local(type: string, args: Record<string, unknown> = {}): Promise<any> {
  const id = randomUUID();
  const response = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Local ${type} timed out: ${diagnostics}`)); }, 10_000);
    pending.set(id, (record) => {
      clearTimeout(timer);
      pending.delete(id);
      if (record.success) resolve(record.data ?? {});
      else reject(new Error(record.error));
    });
  });
  child.stdin.write(JSON.stringify({ id, type, ...args }) + "\n");
  return response;
}
let sessions: Sessions | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let client: Client | undefined;
let duplicate: ReturnType<typeof spawn> | undefined;
let duplicateExited: Promise<void> | undefined;
let terminal: ReturnType<typeof spawn> | undefined;
let terminalExited: Promise<void> | undefined;
let terminalOutput = "";
async function start() {
  sessions = new Sessions(join(directory, "managed"), workspace, "pi", { bridgeDirectory: registry, sessionDirectory: sessionRoot });
  await sessions.load();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createHttpHandler(sessions, new Set(["127.0.0.1"])) });
  client = new Client({ name: "attachment-e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
}
async function stop() {
  await client?.close();
  client = undefined;
  server?.stop(true);
  server = undefined;
  await sessions?.close();
  sessions = undefined;
}
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await client!.callTool({ name, arguments: args });
  check(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse((response.content as { text: string }[])[0]!.text);
}
async function rejected(name: string, args: Record<string, unknown>) {
  check((await client!.callTool({ name, arguments: args })).isError, `${name} should reject`);
}
function hasText(snapshot: any, text: string) {
  return snapshot.messages.some((message: any) => message.role === "assistant" && message.content?.some((block: any) => block.text === text));
}
try {
  const initial = await local("get_state");
  const id = initial.sessionId;
  const metadata = await until(async () => (await discoverBridges(registry)).find((entry) => entry.sessionId === id), "bridge registration");
  check((await stat(registry)).mode % 512 === 448, "Registry is not private");
  check((await stat(join(registry, `${metadata.runtimeId}.sock`))).mode % 512 === 384, "Socket is not private");
  await start();
  const listed = await call("list_sessions");
  check(listed.sessions.some((session: any) => session.sessionId === id && session.ownership === "attached"), "Existing Pi was not attached");
  const snapshot = await call("read_session", { sessionId: id });
  check(!snapshot.capabilities.stop && !snapshot.capabilities.interactions, "Attached capabilities overpromise");
  const target = { sessionId: id, runtimeId: snapshot.runtimeId, commandId: randomUUID() };
  await rejected("stop_session", target);
  await rejected("respond_to_interaction", { ...target, commandId: randomUUID(), interactionId: "unused", response: { cancelled: true } });
  await rejected("fork_session", { sessionId: id });
  await rejected("send_message", { ...target, commandId: randomUUID(), runtimeId: randomUUID(), message: "never" });
  const sent = await call("send_message", { ...target, commandId: randomUUID(), message: "slow" });
  check(sent.disposition === "dispatched", "Dispatch was misrepresented as acceptance/completion");
  await until(async () => {
    const state = await call("read_session", { sessionId: id });
    return state.partialText === "REPLY:" && state.state.isStreaming ? state : undefined;
  }, "live partial text");
  await rejected("send_message", { ...target, commandId: randomUUID(), message: "busy prompt" });
  const steering = { ...target, commandId: randomUUID(), message: "steered", intent: "steer" };
  await call("send_message", steering);
  await call("send_message", steering);
  await rejected("send_message", { ...steering, message: "changed" });
  await call("send_message", { ...target, commandId: randomUUID(), message: "followed", intent: "follow_up" });
  const settled = await until(async () => {
    const state = await call("read_session", { sessionId: id, limit: 20 });
    return hasText(state, "REPLY:followed") && !state.state.isStreaming ? state : undefined;
  }, "steer and follow-up completion");
  check(requests.filter((text) => text === "steered").length === 1, "Duplicate steering was delivered");
  check(settled.recentCommands.every((command: any) => command.status === "message_recorded"), "Delivery evidence was not recorded");
  await stop();
  check((await local("get_state")).sessionId === id, "MCP shutdown killed attached Pi");
  await start();
  check((await call("resume_session", { sessionId: id })).runtimeId === snapshot.runtimeId, "MCP restart replaced attached Pi");
  const direct = { commandId: randomUUID(), message: "across restart", intent: "prompt" };
  await bridgeRequest(registry, metadata, "send", direct);
  await until(async () => hasText(await call("read_session", { sessionId: id }), "REPLY:across restart") ? true : undefined, "direct bridge delivery");
  await stop();
  await start();
  await call("send_message", { sessionId: id, runtimeId: metadata.runtimeId, ...direct });
  check(requests.filter((text) => text === "across restart").length === 1, "Bridge deduplication did not survive MCP restart");
  await local("set_session_name", { name: "Renamed locally" });
  check((await call("list_sessions")).sessions.some((entry: any) => entry.name === "Renamed locally"), "Local rename was not reflected");
  await local("new_session");
  await rejected("send_message", { ...target, commandId: randomUUID(), message: "wrong session" });
  const saved = await call("read_session", { sessionId: id, limit: 20 });
  check(saved.ownership === "saved" && hasText(saved, "REPLY:followed"), "Saved history was not readable without resume");
  const original = await readFile(saved.state.sessionFile, "utf8");
  await rejected("resume_session", { sessionId: id });
  const forked = await call("fork_session", { sessionId: id, name: "Separate copy" });
  check(forked.sessionId !== id && hasText(await call("read_session", { sessionId: forked.sessionId, limit: 20 }), "REPLY:followed"), "Saved fork lost conversation");
  check(await readFile(saved.state.sessionFile, "utf8") === original, "Source history was modified");
  await local("switch_session", { sessionPath: saved.state.sessionFile });
  const switched = await call("read_session", { sessionId: id });
  check(switched.runtimeId !== metadata.runtimeId && hasText(switched, "REPLY:followed"), "Switch did not replace bridge context");
  await rejected("send_message", { ...target, commandId: randomUUID(), message: "stale switch" });
  duplicate = spawn("pi", ["--mode", "rpc", "--no-extensions", "--extension", extension, "--session", saved.state.sessionFile], {
    cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_MCP_BRIDGE_DIR: registry, PI_MCP_MANAGED: "0" }, stdio: "pipe",
  });
  duplicate.stdout!.resume();
  duplicate.stderr!.on("data", (chunk) => { diagnostics += chunk; });
  duplicateExited = new Promise<void>((resolve) => duplicate!.on("close", () => resolve()));
  await until(async () => (await discoverBridges(registry)).filter((entry) => entry.sessionId === id).length === 2 ? true : undefined, "duplicate live owners");
  await rejected("read_session", { sessionId: id });
  await rejected("send_message", { sessionId: id, runtimeId: switched.runtimeId, commandId: randomUUID(), message: "ambiguous owner" });
  duplicate.stdin!.end();
  await duplicateExited;
  check((await local("get_state")).sessionId === id, "Duplicate detection interrupted original owner");
  await local("new_session");
  const newId = (await local("get_state")).sessionId;
  await local("prompt", { message: "/pi-mcp off" });
  await rejected("read_session", { sessionId: newId });
  await local("prompt", { message: "/pi-mcp on" });
  const enabled = await call("read_session", { sessionId: newId });
  check(enabled.ownership === "attached" && enabled.runtimeId !== metadata.runtimeId, "Bridge did not re-enable with fresh identity");
  const scoped = new Sessions(join(directory, "scoped"), join(workspace, "unrelated"), "pi", { bridgeDirectory: registry, sessionDirectory: sessionRoot });
  await scoped.load();
  check((await scoped.list()).length === 0, "Out-of-scope histories were exposed");
  await scoped.close();
  const outsideId = randomUUID();
  const fixture = (await readFile(join(import.meta.dir, "fixtures/openox-v1/history.jsonl"), "utf8")).replaceAll("@WORKSPACE@", directory).replaceAll("0c637271-808b-4471-ac97-5a1cd3419d92", outsideId);
  await mkdir(join(sessionRoot, "outside"), { recursive: true });
  await writeFile(join(sessionRoot, "outside", `${outsideId}.jsonl`), fixture);
  check(!(await call("list_sessions")).sessions.some((entry: any) => entry.cwd === directory), "Outside workspace leaked");
  const legacyId = randomUUID();
  const legacyPath = join(sessionRoot, "legacy.jsonl");
  const legacyFixture = (await readFile(join(import.meta.dir, "fixtures/openox-v1/history.jsonl"), "utf8")).replaceAll("@WORKSPACE@", workspace).replaceAll("0c637271-808b-4471-ac97-5a1cd3419d92", legacyId).replace('"version":3', '"version":2');
  await writeFile(legacyPath, legacyFixture);
  check(hasText(await call("read_session", { sessionId: legacyId }), "PERSISTED_BEFORE_EXTRACTION"), "Legacy history was not readable");
  check(await readFile(legacyPath, "utf8") === legacyFixture, "Read-only discovery migrated a legacy file on disk");
  const deadId = randomUUID();
  await writeFile(join(registry, `${deadId}.json`), JSON.stringify({ ...metadata, runtimeId: deadId }), { mode: 0o600 });
  check((await call("list_sessions")).sessions.some((entry: any) => entry.sessionId === newId), "Stale registry entry broke discovery");
  await rm(join(registry, `${deadId}.json`));
  await stop();
  child.stdin.end();
  await Promise.race([exited, Bun.sleep(10_000).then(() => { throw new Error("Attached Pi did not exit locally"); })]);
  check((await readdir(registry)).length === 0, "Bridge endpoints survived Pi shutdown");
  terminal = spawn("python3", [join(import.meta.dir, "fixtures/terminal.py"), "pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", resolve(import.meta.dir, ".."), "--provider", "fixture", "--model", "fixture"], {
    cwd: workspace, env: { ...process.env, TERM: "xterm-256color", PI_CODING_AGENT_DIR: agent, PI_MCP_BRIDGE_DIR: registry, PI_MCP_MANAGED: "0" }, stdio: "pipe",
  });
  terminal.stdout!.on("data", (chunk) => { terminalOutput += chunk; });
  terminal.stderr!.on("data", (chunk) => { diagnostics += chunk; });
  terminalExited = new Promise<void>((resolve) => terminal!.on("close", () => resolve()));
  const interactive = await until(async () => (await discoverBridges(registry)).find((entry) => entry.mode === "tui"), "real TUI registration through package manifest");
  await start();
  await call("send_message", { sessionId: interactive.sessionId, runtimeId: interactive.runtimeId, commandId: randomUUID(), message: "terminal remote" });
  await until(async () => hasText(await call("read_session", { sessionId: interactive.sessionId }), "REPLY:terminal remote") ? true : undefined, "remote response in TUI session");
  const type = (text: string) => terminal!.stdin!.write(`\u001b[200~${text}\u001b[201~\r`);
  type("terminal local");
  await until(async () => hasText(await call("read_session", { sessionId: interactive.sessionId }), "REPLY:terminal local") ? true : undefined, "local terminal input visible remotely");
  check(terminalOutput.includes("terminal remote") && terminalOutput.includes("terminal local"), "Shared responses were not rendered in terminal");
  type("/reload");
  const reloaded = await until(async () => (await discoverBridges(registry)).find((entry) => entry.sessionId === interactive.sessionId && entry.runtimeId !== interactive.runtimeId), "TUI reload bridge replacement");
  await rejected("send_message", { sessionId: interactive.sessionId, runtimeId: interactive.runtimeId, commandId: randomUUID(), message: "stale reload" });
  check((await call("read_session", { sessionId: interactive.sessionId })).runtimeId === reloaded.runtimeId, "Reload did not preserve conversation identity");
  type("/pi-mcp off");
  await until(async () => (await discoverBridges(registry)).length === 0 ? true : undefined, "local TUI disable");
  type("/reload");
  await Bun.sleep(1000);
  check((await discoverBridges(registry)).length === 0, "Reload unexpectedly re-enabled remote access");
  await stop();
  terminal.kill("SIGTERM");
  await terminalExited;
  console.log("PASS: real RPC and TUI Pi attachment, shared local/remote conversation, streaming, prompt/steer/follow-up, delivery evidence, dedup across MCP restarts, terminal lifetime, stale/reload targets, local disable, saved/legacy reads and forks, workspace scope, private sockets and cleanup; local fixture model only");
} finally {
  await stop();
  duplicate?.kill("SIGTERM");
  if (duplicateExited) await Promise.race([duplicateExited, Bun.sleep(5000).then(() => duplicate?.kill("SIGKILL"))]);
  terminal?.kill("SIGTERM");
  if (terminalExited) await Promise.race([terminalExited, Bun.sleep(5000).then(() => terminal?.kill("SIGKILL"))]);
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(5000).then(() => child.kill("SIGKILL"))]);
  model.stop(true);
  await rm(directory, { recursive: true, force: true });
}

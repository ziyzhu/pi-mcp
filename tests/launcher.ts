/** E2E of the executable launcher, real HTTP ingress and real Pi processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-mcp-launcher-")));
const script = resolve(import.meta.dir, "../scripts/serve-pi");
type Running = { child: ChildProcess; exited: Promise<number>; output: () => string };
const processes: Running[] = [];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function port(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const value = reservation.port!;
  reservation.stop(true);
  return value;
}
function launch(args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(script, args, { cwd: directory, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const result = { child, exited, output: () => output };
  processes.push(result);
  return result;
}
async function waitFor(checkReady: () => Promise<boolean>, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await checkReady()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }
async function exit(process: Running): Promise<number> {
  return Promise.race([process.exited, Bun.sleep(15_000).then(() => { throw new Error(`Launcher did not exit: ${process.output()}`); })]);
}
let client: Client | undefined;
try {
  const help = launch(["--help"]);
  check(await exit(help) === 0 && help.output().includes("--tailscale"), "Help failed");
  const invalid = launch(["--port", "0"]);
  check(await exit(invalid) === 1 && invalid.output().includes("Invalid port"), "Invalid port accepted");
  const data = join(directory, "data");
  const backendPort = port();
  const args = ["--port", String(backendPort), "--data-dir", data];
  const server = launch(args, { PI_MCP_TAILSCALE_BIN: "/does-not-exist" });
  const endpoint = new URL(`http://127.0.0.1:${backendPort}/mcp`);
  await waitFor(async () => {
    try { return (await fetch(new URL("/health", endpoint))).ok; } catch { return false; }
  }, "loopback health");
  const health = await (await fetch(new URL("/health", endpoint))).json() as { name: string };
  check(health.name === "pi-mcp", "Wrong health identity");
  await waitFor(async () => server.output().includes("MCP endpoint:"), "readiness announcement");
  check(server.output().includes(`Allowed initial directory: ${directory}`), "Shell launcher changed caller cwd");
  client = new Client({ name: "launcher-e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const created = await client.callTool({ name: "create_session", arguments: { cwd: directory, name: "Launcher E2E" } });
  check(!created.isError, `Real Pi did not start: ${JSON.stringify(created.content)}`);
  const locked = launch(["--port", String(port()), "--data-dir", data]);
  check(await exit(locked) === 1 && locked.output().includes("storage is locked"), "Concurrent writer accepted");
  check((await fetch(new URL("/health", endpoint))).ok, "Contending launcher interrupted owner");
  await client.close();
  client = undefined;
  server.child.kill("SIGTERM");
  check(await exit(server) === 0, `Shutdown failed: ${server.output()}`);
  check(!await exists(join(data, "serve.lock")), "Lock survived clean shutdown");
  check(server.output().includes('"event":"process_exit"'), "Pi process did not exit with launcher");
  const unreachable = await fetch(new URL("/health", endpoint)).then(() => false, () => true);
  check(unreachable, "HTTP listener survived shutdown");

  // A temporary Tailscale executable fixture exercises refusal and process-group
  // shutdown. This does not verify a real Tailscale HTTPS publication.
  const tailscale = join(directory, "tailscale");
  const sleeper = join(directory, "sleeper.pid");
  await writeFile(tailscale, `#!/bin/sh
case "$*" in
  'status --json') printf '%s\\n' '{"BackendState":"Running","Self":{"Online":true,"DNSName":"fixture.ts.net."}}' ;;
  'serve status --json')
    if [ "$PI_MCP_TEST_BUSY" = 1 ]; then printf '%s\\n' '{"TCP":{"443":{"HTTPS":true}}}'; else printf '%s\\n' '{}'; fi ;;
  'serve --yes '*) sleep 300 & echo $! > "$PI_MCP_TEST_SLEEPER"; wait ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const publishedArgs = ["--tailscale", "--port", String(port()), "--data-dir", data];
  const busy = launch(publishedArgs, { PI_MCP_TAILSCALE_BIN: tailscale, PI_MCP_TEST_BUSY: "1" });
  check(await exit(busy) === 1 && busy.output().includes("already has an active route"), "Existing publication was not refused");
  check(!await exists(join(data, "serve.lock")), "Failed publication retained lock");
  const starting = launch(publishedArgs, { PI_MCP_TAILSCALE_BIN: tailscale, PI_MCP_TEST_BUSY: "0", PI_MCP_TEST_SLEEPER: sleeper });
  await waitFor(() => exists(sleeper), "Tailscale wrapper child");
  const sleeperPid = Number((await readFile(sleeper, "utf8")).trim());
  starting.child.kill("SIGTERM");
  await exit(starting);
  await waitFor(async () => {
    try { process.kill(sleeperPid, 0); return false; } catch { return true; }
  }, "Tailscale wrapper child cleanup");
  check(!await exists(join(data, "serve.lock")), "Aborted publication retained lock");
  console.log("PASS: executable launcher, loopback-only operation, caller cwd, real Pi, writer lock, shutdown, Tailscale refusal and wrapper cleanup");
} finally {
  await client?.close();
  for (const process of processes) process.child.kill("SIGTERM");
  await Promise.allSettled(processes.map((process) => exit(process)));
  await rm(directory, { recursive: true, force: true });
}

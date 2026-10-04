import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

type JSONObject = Record<string, unknown>;

// Tailscale may be a shell wrapper. Own a process group so shutdown also stops
// the actual executable and cannot leave a publication or pipe reader behind.
function start(binary: string, args: string[]) {
  const child = spawn(binary, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  return { stdout: child.stdout, stderr: child.stderr, exited, kill };
}

export type ManagedTailscaleServe = {
  endpoint: string;
  exited: Promise<number>;
  stop: () => Promise<void>;
  exitMessage: () => Promise<string>;
};

function object(value: unknown): JSONObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tailscale returned invalid JSON");
  return value as JSONObject;
}

async function output(stream: Readable, bounded = true): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (bounded) text = text.slice(-16_384);
  }
  return text + decoder.decode();
}

async function runJSON(binary: string, args: string[]): Promise<JSONObject> {
  const child = start(binary, args);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, output(child.stdout, false), output(child.stderr)]);
    if (code !== 0) throw new Error(stderr.trim() || `Tailscale exited with status ${code}`);
    return object(JSON.parse(stdout));
  } finally { clearTimeout(timer); }
}

function dnsName(status: JSONObject): string {
  if (status.BackendState !== "Running") throw new Error("Tailscale is not running; connect it before starting pi-mcp");
  const self = object(status.Self);
  if (self.Online !== true) throw new Error("This machine is offline in Tailscale; connect it before starting pi-mcp");
  const name = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
  if (!/^[a-z0-9.-]+\.ts\.net$/i.test(name)) throw new Error("Tailscale MagicDNS is unavailable; enable it before starting pi-mcp");
  return name;
}

function servesTarget(status: JSONObject, name: string, target: string): boolean {
  const web = object(status.Web ?? {});
  const site = object(web[`${name}:443`] ?? {});
  const handlers = object(site.Handlers ?? {});
  return object(handlers["/"] ?? {}).Proxy === `http://${target}`;
}

/** Foreground Serve only: never reset, replace, or take ownership of an existing route. */
export async function startTailscaleServe(
  port: number,
  allowHost: (name: string) => void,
  signal: AbortSignal,
): Promise<ManagedTailscaleServe> {
  const binary = process.env.PI_MCP_TAILSCALE_BIN ?? "tailscale";
  const name = dnsName(await runJSON(binary, ["status", "--json"]));
  const existing = await runJSON(binary, ["serve", "status", "--json"]);
  if (Object.keys(existing).length > 0) throw new Error("Tailscale Serve already has an active route. pi-mcp will not replace it. Explicitly free the existing route before starting pi-mcp.");
  signal.throwIfAborted();
  allowHost(name);
  const target = `127.0.0.1:${port}`;
  const child = start(binary, ["serve", "--yes", target]);
  void output(child.stdout);
  const stderr = output(child.stderr);
  const exited = child.exited;
  let code: number | undefined;
  void exited.then((value) => { code = value; }, () => { code = 1; });
  const terminate = () => { if (code === undefined) child.kill("SIGINT"); };
  signal.addEventListener("abort", terminate, { once: true });
  const stop = async () => {
    signal.removeEventListener("abort", terminate);
    terminate();
    const force = setTimeout(() => { if (code === undefined) child.kill("SIGKILL"); }, 5000);
    try { await exited; }
    finally { clearTimeout(force); }
  };
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (code !== undefined) throw new Error(`Tailscale Serve exited with status ${code}`);
      const status = await runJSON(binary, ["serve", "status", "--json"]);
      if (servesTarget(status, name, target)) {
        try {
          const response = await fetch(`https://${name}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          const health = await response.json() as { name?: string; contractVersion?: number };
          if (response.ok && health.name === "pi-mcp" && health.contractVersion === 1) { ready = true; break; }
        } catch { signal.throwIfAborted(); }
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error("Tailscale Serve did not make the MCP endpoint reachable within 30 seconds");
    return { endpoint: `https://${name}/mcp`, exited, stop, exitMessage: async () => (await stderr).trim() };
  } catch (error) {
    await stop();
    throw new Error((await stderr).trim() || (error as Error).message);
  }
}

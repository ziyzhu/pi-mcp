import { execFileSync } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpHandler } from "./server.ts";
import { diagnostic, Sessions } from "./sessions.ts";
import { startTailscaleServe, type ManagedTailscaleServe } from "./tailscale.ts";

const help = `Usage: scripts/serve-pi [--tailscale] [--port <port>] [--directory <path>] [--data-dir <path>] [--pi <executable>]

Serve managed Pi sessions as MCP on loopback, optionally published through Tailscale.
No pairing or bearer token: only expose this server to trusted callers.

  --tailscale   Publish HTTPS on port 443; restrict Tailscale grants/ACLs first
  --port        Loopback HTTP port (default 9877)
  --directory   Allowed initial working-directory root (default current directory)
  --data-dir    Managed session storage (default ~/.pi-mcp)
  --pi          Installed Pi executable (default pi)

Optional publication requires connected Tailscale, MagicDNS, and HTTPS/Serve.
pi-mcp refuses to replace existing Serve configuration and stops its own foreground
Serve process on exit. TLS and certificate management are handled by Tailscale.

Pi must be installed, authenticated, and project trust configured locally.
Working-directory restrictions are NOT a sandbox. Agents run as your user.
Clients poll read_session; resource subscriptions are not yet provided.
`;

async function configuration(args: string[]) {
  const options: Record<string, string> = {};
  let tailscale = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--tailscale" && !tailscale) { tailscale = true; continue; }
    const value = args[++index];
    if (!["--port", "--directory", "--data-dir", "--pi"].includes(flag) || !value || value.startsWith("--") || options[flag]) throw new Error(help);
    options[flag] = value;
  }
  const port = Number(options["--port"] ?? 9877);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const root = await realpath(options["--directory"] ?? process.cwd());
  const directory = resolve(options["--data-dir"] ?? join(homedir(), ".pi-mcp"));
  const executable = options["--pi"] ?? "pi";
  return { port, root, directory, executable, tailscale };
}

export async function serve(args: string[]): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(help); return; }
  const { port, root, directory, executable, tailscale } = await configuration(args);
  try { execFileSync(executable, ["--version"], { timeout: 10_000, stdio: "pipe" }); }
  catch { throw new Error("Pi executable is unavailable; install Pi or specify --pi"); }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "serve.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error(`Session storage is locked. Check for another pi-mcp or ox serve process. After a crash, remove ${lock} only after confirming no server is running.`); }
  const sessions = new Sessions(join(directory, "sessions"), root, executable);
  const controller = new AbortController();
  const shutdown = new Promise<void>((done) => controller.signal.addEventListener("abort", () => done(), { once: true }));
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let publication: ManagedTailscaleServe | undefined;
  let stopServer: (() => void) | undefined;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, address: "127.0.0.1", port }), { mode: 0o600 });
    await sessions.load();
    const allowedHosts = new Set(["127.0.0.1"]);
    const server = Bun.serve({
      hostname: "127.0.0.1", port, idleTimeout: 60, maxRequestBodySize: 1024 * 1024,
      fetch: createHttpHandler(sessions, allowedHosts),
    });
    stopServer = () => { server.stop(true); };
    if (tailscale) publication = await startTailscaleServe(port, (name) => allowedHosts.add(name), controller.signal);
    controller.signal.throwIfAborted();
    const endpoint = publication?.endpoint ?? `http://127.0.0.1:${port}/mcp`;
    diagnostic("started", { endpoint, directory: root, tailscale });
    console.log(`MCP endpoint: ${endpoint}\nAllowed initial directory: ${root}\nAccess: ${tailscale ? "Tailscale grants/ACLs" : "local processes"}; no pairing.\nPress Ctrl+C to shut down managed Pi processes.`);
    const code = await Promise.race([shutdown.then(() => undefined), ...(publication ? [publication.exited] : [])]);
    if (!controller.signal.aborted && code !== undefined) throw new Error(await publication?.exitMessage() || `Tailscale Serve exited with status ${code}`);
  } finally {
    try { await publication?.stop(); }
    finally {
      stopServer?.();
      await sessions.close();
      await rm(lock, { recursive: true, force: true });
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      diagnostic("stopped");
    }
  }
}

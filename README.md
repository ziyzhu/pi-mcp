# pi-mcp

An MCP server that manages [Pi](https://pi.dev) coding-agent subprocesses through
Pi RPC. Works with any Streamable HTTP MCP client, including Ox. No Pi extension
is required.

## Run

Requires macOS or Linux, [Bun](https://bun.sh) 1.3+, and Pi 1.0.2+ (tested with 1.1.0).
Configure credentials and project trust in Pi locally; pi-mcp does not bundle Pi
or automatically approve project resources.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
git clone https://github.com/ziyzhu/pi-mcp.git
cd pi-mcp
bun install --frozen-lockfile
./scripts/serve-pi --directory ~/work
```

Add the printed `http://127.0.0.1:9877/mcp` URL to your MCP client. The server
always binds to loopback.

For private remote access, connect Tailscale, enable MagicDNS and HTTPS/Serve,
and restrict grants/ACLs to intended callers on HTTPS port 443 **before** running:

```sh
./scripts/serve-pi --tailscale --directory ~/work
```

Wait for the printed `https://…ts.net/mcp` URL. The launcher verifies publication,
refuses to overwrite existing routes, and never enables Funnel. Ctrl+C stops its
Pi and Tailscale processes; saved conversations remain resumable. Disconnecting
a client does not stop work. Server shutdown does not automatically restart
unfinished tasks.

| Option | Default |
| --- | --- |
| `--tailscale` | Off |
| `--port` | `9877` (loopback; Tailscale HTTPS uses 443) |
| `--directory` | Caller's cwd; workspace root for creation and saved-history exposure |
| `--data-dir` | `~/.pi-mcp` |
| `--pi` | `pi` |
| `--session-dir` | Existing Pi storage root: `~/.pi/agent/sessions` (or under `PI_CODING_AGENT_DIR`) |

Use `--help` for details. `PI_MCP_TAILSCALE_BIN` overrides the Tailscale executable.

## Saved Pi histories

Discovery includes Pi's normal workspace-grouped storage and flat custom session
directories within the configured workspace. Pass `--session-dir` for custom storage.
Saved histories are readable without starting Pi. Their live ownership is unknown,
so `resume_session` refuses external histories. `fork_session` copies persisted
history into a separate managed RPC conversation without changing the original.
It does not copy unfinished in-memory output or attach to a running terminal agent.
Concurrent filesystem changes in the same workspace remain your responsibility.

Managed RPC sessions support prompting, steering, follow-ups, stopping, and supported
Pi dialogs. Terminal attachment and custom terminal dialogs are unavailable.
If you previously installed pi-mcp as a Pi extension, remove that package from Pi's
configuration with `pi remove /absolute/path/to/pi-mcp` before updating it.

## Security

**Callers can run agents with your account's filesystem, credential, process,
and network permissions.** The working-directory restriction is not a sandbox.
There is no pairing or bearer token; local processes can connect, and remote
access relies on Tailscale ACLs. The workspace root also limits which
saved histories MCP clients can see; histories may contain sensitive data.
Do not expose the server through a public proxy.
Use a dedicated account, container, or VM when isolation is required.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_sessions` | List managed sessions and saved histories within scope |
| `create_session` | Create a session and launch Pi without prompting |
| `resume_session` | Start a managed saved session or reuse its RPC process |
| `fork_session` | Copy external saved history into a separate managed session |
| `read_session` | Read state, messages, progress, and pending dialogs |
| `send_message` | Prompt, steer, or queue a follow-up |
| `stop_session` | Clear queued input and interrupt managed RPC work |
| `respond_to_interaction` | Answer a supported Pi RPC dialog |

**Acceptance is not completion:** poll `read_session`. Managed saved sessions
require resume before reading; external saved histories are readable directly.
At most 16 managed Pi RPC processes run concurrently. Message pages and large
projections are bounded.

`send_message`, `stop_session`, and `respond_to_interaction` require the current
`runtimeId` and a caller-generated UUID `commandId`. Identical retries are
deduplicated only until server restart
(maximum 10,000 mutations). `create_session` and `fork_session` are not deduplicated.
Never blindly retry after unknown delivery; reconcile with session state first.

Snapshot resources: `pi-mcp://sessions` and `pi-mcp://sessions/{sessionId}`.
Push notifications and resource subscriptions are not implemented.

## Storage

`--data-dir` contains version-1 metadata at `sessions/<uuid>/session.json`,
Pi-owned conversation files under `sessions/<uuid>/pi/`, and `serve.lock/`.
Backup and retention are operator-controlled; nothing is automatically deleted,
relocated, or synced. After a crash, confirm no server or orphaned Pi process
remains before removing the lock. Diagnostics are structured JSON on stderr;
prompt bodies and Pi stderr are not forwarded into server logs.

To reuse an OpenOx store, stop `ox serve`, then run:

```sh
./scripts/serve-pi --data-dir ~/.openox/serve --directory /your/original/root --tailscale
```

Storage formats are unchanged. Never run both servers against one store.
Reconnect clients and update resource URIs from `ox://sessions…` to
`pi-mcp://sessions…`.

## Development

```sh
bun run typecheck
bun run test:e2e # Requires Pi
bun tests/lifecycle.ts --prompt # Optional real-model smoke; may incur costs
```

E2Es use real MCP/Pi RPC processes and temporary stores, including a sanitized
pre-extraction storage fixture and external saved histories. No model calls occur
unless the optional real-model smoke is requested. Tailscale checks use a fixture
executable; verify live HTTPS publication separately with `--tailscale`.

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.

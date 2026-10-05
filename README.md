# pi-mcp

An MCP server that lets clients create, discover, and attach to [Pi](https://pi.dev)
coding-agent sessions, including sessions already running in terminals. Works with
any Streamable HTTP MCP client, including Ox.

## Run

Requires macOS or Linux, [Bun](https://bun.sh) 1.3+, and Pi 1.0.2+ (tested with 1.0.2).
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
| `--directory` | Caller's cwd; workspace root for creation and existing-session exposure |
| `--data-dir` | `~/.pi-mcp` |
| `--pi` | `pi` |
| `--session-dir` | Existing Pi storage root: `~/.pi/agent/sessions` (or under `PI_CODING_AGENT_DIR`) |
| `--bridge-dir` | `PI_MCP_BRIDGE_DIR` or `~/.pi-mcp/bridges` |

Use `--help` for details. `PI_MCP_TAILSCALE_BIN` overrides the Tailscale executable.

## Existing Pi sessions

Install the bridge as a local Pi package:

```sh
pi install /absolute/path/to/pi-mcp
```

New interactive sessions load it automatically. In already-open sessions, run
`/reload` while idle. To try it without installing, use `pi -e /absolute/path/to/pi-mcp`.
The bridge also supports independently launched RPC sessions; managed subprocesses
are excluded automatically. Print and JSON modes do not expose a bridge.

Run the MCP server with a workspace root covering the sessions you intend to expose:

```sh
./scripts/serve-pi --directory ~/workplace
```

`list_sessions` distinguishes `managed`, `attached`, and `saved` ownership and
advertises capabilities. Attached sessions share the existing Pi agent and active
branch: local and remote messages appear in the same conversation. MCP disconnects
and server shutdown leave these processes running. Reloading, switching, or forking
locally replaces `runtimeId`; stale commands cannot reach the replacement runtime.

Attached sends return `dispatched`, not Pi acceptance or completion. Poll history,
`partialText`, and `recentCommands` for evidence. Command status progresses from
`dispatched` to `input_observed` and, when the matching user message enters the
conversation, `message_recorded`. Other extensions may transform or consume input;
unconfirmed delivery must not be blindly retried. Remote text is literal: slash
commands, skills, and prompt templates are not expanded by the bridge.

Terminal status indicates remote access. `/pi-mcp off` disables it for this process,
including across reloads; `/pi-mcp on` enables it with a fresh runtime identity.
Attached queue-clearing stops and dialog responses are unavailable: use the terminal
for cancellation and approvals. Custom terminal dialogs are not mirrored remotely.

Saved history is readable without starting Pi. Live ownership without a bridge is
unknown, so `resume_session` refuses external saved histories. `fork_session` copies
the persisted history into a separate managed conversation without changing the
original. It does not attach to an unbridged running process or copy unfinished
in-memory output; concurrent filesystem changes in the same workspace remain your
responsibility. Fork attached sessions locally with `/fork`.

Discovery includes Pi's normal workspace-grouped storage and flat custom session
directories. Pass `--session-dir` for custom storage. If changing the bridge registry,
set the same absolute `PI_MCP_BRIDGE_DIR` when launching Pi and use `--bridge-dir`
for the server. The directory must be private (0700), with a short enough path for
Unix sockets. Dead registry records are ignored; after a crash remove only endpoints
whose Pi process has exited. Duplicate live session IDs are not controllable.

## Security

**Callers can run agents with your account's filesystem, credential, process,
and network permissions.** The working-directory restriction is not a sandbox.
There is no pairing or bearer token; local processes can connect, and remote
access relies on Tailscale ACLs. Installing the bridge grants same-user local processes
access to enabled sessions even when the MCP server is not running. Unix sockets and
registry records are private to the user. The workspace root also limits which
existing sessions MCP clients can see; their histories may contain sensitive data. Do not expose the server through a public proxy.
Use a dedicated account, container, or VM when isolation is required.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_sessions` | List managed, attached, and saved sessions within scope |
| `create_session` | Create a session and launch Pi without prompting |
| `resume_session` | Start a managed saved session or reuse a live process |
| `fork_session` | Copy external saved history into a separate managed session |
| `read_session` | Read state, messages, progress, and pending dialogs |
| `send_message` | Prompt, steer, or queue a follow-up |
| `stop_session` | Managed sessions: clear queued input and interrupt work |
| `respond_to_interaction` | Managed sessions: answer a supported Pi dialog |

**Acceptance is not completion:** poll `read_session`. Managed saved sessions
require resume before reading; external saved histories are readable directly.
At most 16 managed Pi processes run concurrently; attached processes are owned by
their terminals. Message pages and large projections are bounded.

`send_message`, `stop_session`, and `respond_to_interaction` require the current
`runtimeId` and a caller-generated UUID `commandId`. Identical retries are
deduplicated only until server restart
(maximum 10,000 mutations). Attached sends are additionally deduplicated in the
bridge until its runtime is replaced (maximum 10,000 sends).
`create_session` and `fork_session` are not deduplicated. Never blindly
retry after unknown delivery; reconcile with session state first.

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
bun run test:e2e # Requires Pi and Python 3 for the real terminal check
bun tests/lifecycle.ts --prompt # Optional real-model smoke; may incur costs
```

E2Es use real MCP/Pi processes, a real terminal via PTY, and temporary stores,
including a sanitized pre-extraction storage fixture. Attachment checks use a local
streaming model fixture without external requests or model charges. Tailscale checks use a fixture executable;
verify live HTTPS publication separately with `--tailscale`.

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.

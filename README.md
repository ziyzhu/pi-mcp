# pi-mcp

Let MCP clients create and control [Pi](https://pi.dev) coding-agent sessions on
another computer. This is an MCP **server for Pi**, not an MCP-client extension
for Pi. Any Streamable HTTP MCP client can connect, including OpenOx.

Each active session owns a Pi subprocess. Client disconnects do not stop its
work. Conversations remain resumable after server shutdown; unfinished work is
not automatically restarted.

## Run

Requirements: macOS or Linux, [Bun](https://bun.sh) 1.3+, and an installed Pi
coding agent. Verified with Pi 1.0.0. Configure model credentials and project
trust in Pi locally before using remote sessions. pi-mcp uses the installed
`pi` executable and does not bundle Pi or choose a model provider for you.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

git clone https://github.com/ziyzhu/pi-mcp.git
cd pi-mcp
bun install --frozen-lockfile

# Local access only; allow session working directories beneath ~/work:
./scripts/serve-pi --directory ~/work
```

The server prints `http://127.0.0.1:9877/mcp`. Add that URL to a local MCP client
using **Streamable HTTP**, not legacy SSE. `GET /health` reports readiness and
protocol identity. A local health response during Tailscale startup does not
mean publication is ready; wait for the printed MCP endpoint.

Without `--directory`, the allowed initial working-directory root is the
caller's current directory, even when invoking the script by absolute path.
`bun run start --directory ~/work` is an equivalent launcher.

### Private remote access through Tailscale

Connect Tailscale and enable MagicDNS and HTTPS/Serve. **Before publishing**, set
Tailscale grants/ACLs to allow only intended callers to reach this computer on
HTTPS port 443. There is no application-level pairing or bearer token.

```sh
./scripts/serve-pi --tailscale --directory ~/work
```

The launcher starts foreground `tailscale serve --yes 127.0.0.1:9877`, verifies
the route and HTTPS health response, and prints `https://…ts.net/mcp` only after
publication is ready. Connect that URL through your remote MCP client's existing
connection settings. Tailscale owns TLS and certificate management.

The server always binds to loopback. Tailscale is optional and the local-only
mode does not invoke it. pi-mcp refuses to overwrite any existing Tailscale Serve
configuration. It never resets routes or enables public Funnel access. If
publication exits unexpectedly, the server shuts down too. Ctrl+C or SIGTERM
stops the launcher, its managed Pi processes, and its own Tailscale process group,
including shell-wrapper children. Saved conversations remain on disk.

### Options

```text
scripts/serve-pi [--tailscale] [--port <port>] [--directory <path>]
                [--data-dir <path>] [--pi <executable>]
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--tailscale` | Off | Publish privately through Tailscale Serve |
| `--port` | `9877` | Loopback backend port; public HTTPS remains on 443 |
| `--directory` | Current directory | Allowed initial working-directory root |
| `--data-dir` | `~/.pi-mcp` | Managed session store |
| `--pi` | `pi` | Installed Pi executable |

For a custom Tailscale executable, set `PI_MCP_TAILSCALE_BIN`.

## MCP tools

Tool names have no provider prefix:

| Tool | Behavior |
| --- | --- |
| `list_sessions` | List live and saved managed sessions |
| `create_session` | Create a session and launch Pi, without submitting a prompt |
| `resume_session` | Start a saved session or reuse its running Pi process |
| `read_session` | Read state, active-branch messages, latest activity, and pending dialogs |
| `send_message` | Submit a `prompt`, `steer`, or `follow_up` message |
| `stop_session` | Clear queued input and interrupt work, retaining the process and history |
| `respond_to_interaction` | Answer a supported pending Pi confirmation, selection, or text dialog |

`create_session` takes `cwd`, optional `name`, and optional
`model: { provider, id }`. Sessions are limited to 16 active Pi processes.
Read the session to obtain its `runtimeId` before mutating it.

`send_message`, `stop_session`, and `respond_to_interaction` require `sessionId`,
current `runtimeId`, and a caller-generated UUID `commandId`. Identical retries
return the same result for the server's lifetime; reusing an ID with different
inputs is rejected. Deduplication is in memory, capped at 10,000 mutations, and
does not survive restart. Do not blindly retry after unknown delivery.
`create_session` is not deduplicated: reconcile with `list_sessions` after an
ambiguous creation outcome rather than creating again.

**Acceptance is not completion.** Poll `read_session` for progress and results.
Resources `pi-mcp://sessions` and `pi-mcp://sessions/{sessionId}` also expose
snapshots. Resource subscriptions, terminal rendering, remote attachment to an
existing interactive Pi process, and push notifications are not implemented.
Saved sessions must be resumed before reading their conversation.

Messages are paginated by active-branch index, which can change after compaction.
Pages contain at most 20 messages; large messages and latest-event projections
are explicitly truncated. Supported RPC dialogs appear in `interactions`;
terminal-only custom Pi dialogs are unavailable.

## Security

**Anyone able to call this server can run agents with your account's filesystem,
process, credential, and network permissions.** An allowed working-directory root
is not a sandbox. Pi's tools can access other paths available to its user.

Use a dedicated OS account, container, or VM when isolation is required. Only
publish to identities you trust to execute code as you. Do not expose the
unauthenticated loopback server through an unprotected public proxy.

Browser Origin headers and unknown Host headers are rejected, but these checks
are not authentication. Local processes can connect in loopback-only mode.
pi-mcp does not automatically trust project resources or pass Pi's `--approve`
flag. Pi's own saved trust decisions apply; in RPC mode, undecided projects may
have their protected resources skipped. See [Pi security documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

## Storage and diagnostics

```text
~/.pi-mcp/
├── serve.lock/owner.json
└── sessions/<uuid>/
    ├── session.json          Version-1 adapter metadata
    └── pi/                   Pi-owned JSONL conversations
```

Metadata is atomically published before Pi launch. Failed launches retain a
resumable catalog entry. Unknown metadata versions fail validation without
rewriting files. pi-mcp does not rewrite Pi's session format; Pi owns its own
format compatibility. No sessions are deleted, migrated, or copied automatically.
Backup and retention are operator-controlled; no cloud synchronization is set up.

A storage lock prevents concurrent writers. After a crash, confirm no server or
orphaned Pi process remains before manually removing `serve.lock`. Runtime IDs,
command deduplication, and conversation projections are memory-only.

Diagnostics are structured JSON on stderr. Prompt bodies and Pi stderr are not
forwarded into server diagnostics. Logs stay under your control; redirect to an
on-device file if desired and choose an appropriate retention policy.

### Existing OpenOx `ox serve` stores

The adapter was extracted from OpenOx. Metadata version 1, the `sessions/` layout,
Pi conversation files, and lock naming are unchanged. To keep an existing store,
stop the old server and run:

```sh
./scripts/serve-pi --data-dir ~/.openox/serve --directory /your/original/root --tailscale
```

This opens the existing store in place; there is no automatic relocation or
legacy-format fallback. Never run both servers against the same store. The MCP
resource scheme and server/health identity are now `pi-mcp`; tool names and `/mcp`
are unchanged. Reconnect clients and update any `ox://sessions` resource URIs.

## Development and verification

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test:e2e
# Optional: one short real-model prompt; uses your configured provider and may cost money.
bun tests/lifecycle.ts --prompt
```

E2Es use real MCP connections, real Pi subprocesses, and isolated temporary
stores outside the checkout. They cover lifecycle, reconnect, deduplication,
stale targets, ingress checks, writer locking, executable startup/shutdown, and
resuming a sanitized store produced by the original OpenOx implementation.

The launcher E2E uses a temporary Tailscale executable fixture to check route
refusal and shell-wrapper cleanup. It does **not** verify a real Tailscale HTTPS
publication. Verify that separately with `--tailscale` and an authorized client.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for extraction attribution.
Pi is a separate project and retains its own license.

# 05 — niCode wire protocol

The contract between the **daemon** (`server/`) and the **app** (`app/`). The types live in [protocol/types.ts](../protocol/types.ts); this document covers semantics. **Change both in the same commit** and bump `PROTOCOL_VERSION` on breaking changes.

## Endpoints

| Endpoint | Served by | Auth | Purpose |
|---|---|---|---|
| `GET /health` | daemon | none | `{"ok":true,"version":"x.y.z","state":"ready"}`, used for liveness checks by the installer and app |
| `GET /setup/status?sid=<setupId>` | Caddy (static file) | setup id in query | Live install progress (`SetupStatus`), readable before the daemon exists |
| `GET /ws` (upgrade) | daemon | bearer token | Everything else |
| `POST /permission` on the **unix socket** `<dataDir>/internal.sock` | daemon | socket file mode 600, plus the `X-Nicode-Internal` secret | Used by the MCP approve tool (see 02). It isn't on the TCP port, so Caddy can never proxy it |

Transport by mode: `https` → `wss://<ip-dashed>.sslip.io/ws` (Caddy terminates TLS). `local` → `ws://<lan-ip>:<port>/ws`. `tailscale` → `ws://<tailnet-ip>:<port>/ws`.

## Authentication
- The app sends `Authorization: Bearer <token>` on the WebSocket upgrade. (React Native's `new WebSocket(url, undefined, { headers })` supports this.)
- Browser fallback (test client only): subprotocol `nicode.<token>`. The daemon echoes `nicode` back.
- **One token per paired device.** `config.json → tokens: [{id, name, sha256, createdAt}]`. The daemon hashes the presented token and compares it in constant time against every entry. The matching entry becomes the connection's `device`, which `server.info` returns.
- Devices are added by `nicode token add <name> [--json]` / `nicode pair` (also what the app runs over SSH, see 04), by the installer (`--token`), or by `auth.rotate`. Adding a device never affects the others.
- The daemon re-reads `tokens` on SIGHUP (`systemctl reload nicode`) and when `config.json` changes. Sockets whose token was removed are closed with code 4401.
- Failed auth is rejected with HTTP 401 before the upgrade. Per-IP exponential backoff applies (client IP comes from `X-Forwarded-For` **only** when the TCP peer is 127.0.0.1).
- Tokens are 32 random bytes as hex (64 chars).
  - `auth.rotate` replaces **only the calling device's** token and keeps its id and name; the old token stops working.
  - `auth.devices` / `auth.revoke` / `auth.renameDevice` manage paired devices from the app.

## Frames
All frames are UTF-8 JSON text messages.

```jsonc
// client → server
{ "id": 7, "method": "fs.read", "params": { "projectPath": "/home/dev/projects/api", "path": "src/index.ts" } }
// server → client (exactly one per request id)
{ "id": 7, "result": { "content": "...", "encoding": "utf8", "mtimeMs": 1739..., "size": 812, "truncated": false } }
{ "id": 7, "error": { "code": "not_found", "message": "src/index.ts does not exist" } }
// server → client, unsolicited
{ "event": "claude.event", "data": { "sessionId": "…", "seq": 42, "ts": "…", "event": { "type": "assistant", … } } }
```

- `id` is a client-chosen positive integer, unique per socket.
- `params` are validated with zod on the server. Failures return `bad_request` with the zod issues in `error.data`.
- The default request timeout on the client is 30 s. Long operations (clone, push, Claude login) respond as soon as they start or finish, as noted per method.
- Every socket receives every event for now (single user). Clients filter by `sessionId` / `termId`.

## Setup gating
Claude counts as logged in when the daemon's user has **either** `~/.claude/.credentials.json` (a normal `claude` → `/login`) **or** `CLAUDE_CODE_OAUTH_TOKEN` in the env file. A server that is already logged in therefore goes straight to `ready`, and the app never shows a login.

While `SetupStatus.state` is `needs_claude_login`, only these methods are allowed: `server.info`, `setup.*`, `auth.rotate`, `push.register`, `projects.*`, `fs.*`, `git.*`, `term.*`. `claude.*` returns `setup_required`.

## Method notes
(Signatures are in `types.ts`; only the non-obvious parts are listed here.)

- **`server.info`**: the first call after connecting. The app checks `protocolVersion` and shows an "update server" banner if it differs.
- **`setup.claudeLogin.start`**: starts `claude setup-token` in a PTY and resolves once the login URL has been parsed (≤ 20 s). Only one login can be in flight; starting again kills the previous one.
- **`setup.claudeLogin.submit`**: writes the code to the PTY and resolves after the token is captured, saved, and verified with a one-shot `claude -p` (≤ 90 s). Then it emits `setup.progress` with `state: "ready"`.
- **`setup.claudeLogin.setToken`**: the manual fallback. It validates the `sk-ant-oat…` shape, saves the token, and verifies it like `submit`.
- **`setup.github.start` / `poll`**: runs `gh auth login --web` in a PTY, parses the one-time code, and the app opens `https://github.com/login/device`. `poll` returns `done` once `gh` exits 0. The daemon then runs `gh auth setup-git` and fills in the git identity if it's missing.
- **`projects.list`**: the directories directly under `projectsRoot`.
- **`projects.clone`**: resolves when the clone finishes. It uses `gh repo clone` when gh is authed, otherwise `git clone`.
- **`fs.*`**: `path` is relative to `projectPath`. `projectPath` must resolve (after realpath) inside `projectsRoot`, and `path` inside `projectPath`; otherwise `forbidden`.
  - `fs.read` caps at 1 MB (`truncated: true`) and returns `base64` for binary files (a NUL byte in the first 8 KB).
  - `fs.write` with `expectedMtimeMs` returns `conflict` if the file changed (for example because the agent edited it).
- **`git.diff`**: a unified diff. Without `path` it covers the whole working tree; `staged` selects `--cached`.
- **`term.open`**: creates or attaches the tmux session `nicode-<name>` (default name: the project folder) and returns `TermInfo`. Output arrives as `term.data` events.
- **`term.attach`**: used after a reconnect. `replay` is the last ≤ 256 KB of output.
- **`term.write`**: `data` is base64 of the raw bytes, which preserves control characters.
- **`term.close`**: `kill: true` kills the tmux session; otherwise it only detaches.
- **`claude.start`**: creates a session, spawns the CLI, sends `prompt` as the first turn, and resolves immediately with the summary (`state: "running"`). The output streams as `claude.event`.
- **`claude.send`**: `busy` while a turn is running; the app should queue the message or offer Stop. If the CLI process exited (idle timeout or crash), the daemon respawns it with `--resume`.
- **`claude.interrupt`**: sends SIGINT. The session goes to `idle` once the process settles.
- **`claude.setMode`**: takes effect on the next turn (the daemon respawns with `--resume` and the new flags if needed).
- **`claude.history`**: returns events with `seq > sinceSeq` (all if omitted), up to 2000 per call. The client pages by calling again with the returned `lastSeq`.
- **`claude.permission.respond`**:
  - `remember: true` stores an allow rule for the project: the tool name, or for `Bash` the first word of the command, such as `npm`.
  - `updatedInput` lets the user edit the input before allowing (for example, tweak a command).
  - `deny` with a `message` is passed back to Claude as the reason.
- **`push.register`**: idempotent. It stores the Expo push token.

## Events
| Event | When |
|---|---|
| `setup.progress` | Any `SetupStatus` change made by the daemon (login done → `ready`) |
| `term.data` / `term.exit` | PTY output / tmux session ended |
| `claude.event` | Every stream-json line from the CLI, plus daemon markers (`type: "nicode"`, `subtype: "user_turn" \| "interrupted" \| "process_exit" \| "error"`) |
| `claude.status` | Session state transitions |
| `claude.permission.request` / `resolved` | The agent wants to use a tool that needs approval / the request was answered or timed out (10 min → deny) |
| `fs.changed` | Debounced (300 ms) file changes in projects the client has open (`fs.list` subscribes the project) |

### Claude event stream
The daemon passes the CLI's stream-json objects through **unchanged** inside `SeqEvent.event`, because the shapes change between CLI versions. The app renders them defensively:

| `event.type` | Meaning | App rendering |
|---|---|---|
| `system` (`subtype: "init"`) | Session started: model, cwd, tools, `session_id` | Small header chip |
| `assistant` | `message.content[]` blocks: `text`, `thinking`, `tool_use{id,name,input}` | Markdown, collapsible thinking, tool card |
| `user` | `message.content[]` with `tool_result{tool_use_id,content,is_error}` | Attach the result to the matching tool card |
| `result` | Turn finished: `subtype` (`success`/`error_*`), `duration_ms`, `num_turns`, `usage`, `result` | Footer; the session becomes idle |
| `nicode` | Daemon markers (see above). `user_turn` carries `{text}` so the history shows the user's own messages | User bubble / notices |

Unknown types are shown as a collapsed "raw event" row, never as an error.

## Reconnect
1. Reconnect with backoff (0.5 s → 30 s max), and immediately when the app returns to the foreground.
2. `server.info`.
3. For each open chat: `claude.history { sessionId, sinceSeq: lastSeenSeq }`, then append.
4. For each open terminal: `term.attach`, write the `replay` into xterm after clearing it.
5. `claude.permission.pending` to show any approvals that arrived while disconnected.

## Pairing URI
```
nicode://pair?h=<host>&p=<port>&s=<https|http>&t=<token>&n=<display name>
```
Produced by `nicode pair` / the installer's QR code, and parsed by `parsePairingUri()` in `types.ts`. App-provisioned servers don't need it, because the app already has the token.

## `status.json` (SetupStatus)
Written by the installer ([installer/lib/status.sh](../installer/lib/status.sh)) during the install, and afterwards by the daemon (the file is owned by the dev user).

```json
{"version":1,"state":"installing","step":"node",
 "steps":[{"id":"system","title":"System packages & swap","status":"done","detail":"upgraded;installed: jq tmux"}, …],
 "host":"203-0-113-7.sslip.io","transport":"https","updatedAt":"2026-10-12T10:00:00Z","error":null}
```
`state`: `installing` → (`base_ready` | `needs_claude_login` → `ready`) or `error`. Step `status`: `pending | running | done | skipped | failed`.

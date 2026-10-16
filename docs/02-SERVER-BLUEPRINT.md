# 02 — Server daemon blueprint (`server/`)

> **Audience:** Claude Code, building `server/` from scratch (run it in WSL; see [03](03-LOCAL-DEV-SETUP.md)). Read [00-OVERVIEW](00-OVERVIEW.md) and [05-PROTOCOL](05-PROTOCOL.md) first. The protocol types in [protocol/types.ts](../protocol/types.ts) are the contract. Import them; don't redefine them.

## Implementation status (v0.2.0)
`server/` implements M1–M7, plus the systemd and reverse-proxy wiring from M8. It is tested on Windows with `npm test`: unit tests, a real daemon over WebSocket, the permission bridge, and Claude sessions driven by `test/fake-claude.mjs`, a stand-in CLI that speaks stream-json. Terminals (tmux) and the symlink guard are only exercised on Linux. Where the code differs from the plan below:
- **No `@modelcontextprotocol/sdk`, `expo-server-sdk` or `simple-git`.**
  - The approve tool is a ~100-line stdio MCP server (`src/mcp/approve-server.ts`). It fails closed: anything unexpected becomes a deny.
  - Push uses Expo's HTTP API directly.
  - Git uses `execFile('git', …)`.
- **CLI capability probe.** At startup the daemon parses `claude --help`.
  - Protocol mode `default` is mapped to the CLI's own name for it (`manual` on CLI 2.1.x).
  - The `auto` mode is exposed when the CLI supports it.
  - `--session-id` and `--permission-prompts host` are only passed when the CLI lists them. `--permission-prompt-tool` is hidden from the help but accepted.
- **Sessions keep two ids.** The daemon's own `sessionId`, which the app uses, and Claude's conversation id from the `init` event, which is used for `--resume`.
- **Test hook.** `NICODE_TEST_CLAUDE_SHIM=<script>` makes the daemon run `node <script> …` instead of the real CLI.
- **Browser test console.** `server/scripts/test-client.html`. Open the file locally, enter `wss://<host>/ws` and a device token.

 (paste into Claude Code at the repo root, inside WSL)
```
Read CLAUDE.md, docs/00-OVERVIEW.md, docs/02-SERVER-BLUEPRINT.md and docs/05-PROTOCOL.md.
Build server/ milestone by milestone (M1 → M8) exactly as specified. After each milestone,
run its acceptance checks, fix failures, then stop and summarise what was built before moving on.
Never change the wire protocol without updating protocol/types.ts and docs/05-PROTOCOL.md together.
```

## What the daemon is
A single Node process running as the **configured user**, started by systemd. That is normally a regular developer user; on existing droplets where Claude is already logged in as root, the installer reuses `root` so nothing has to be logged in again. Either way the daemon itself never calls sudo. It is (`/etc/systemd/system/nicode.service`, written by the installer). It:
- serves `/health` and a WebSocket RPC API on `127.0.0.1:<port>`, with Caddy in front providing TLS
- runs Claude Code sessions in stream-json mode and relays permission prompts to the phone
- provides tmux-backed terminals, file access and git operations scoped to `~/projects`
- drives the Claude and GitHub logins on behalf of the app
- sends Expo push notifications

## Stack
- Node **22** and TypeScript (ESM, `"type": "module"`, `moduleResolution: "nodenext"`, `strict`).
- Runtime dependencies: `ws`, `node-pty`, `simple-git`, `zod`, `pino`, `expo-server-sdk`, `@modelcontextprotocol/sdk`, `chokidar`, `strip-ansi`.
- Dev dependencies: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/ws`.
- Scripts:
  - `dev` = `tsx watch src/index.ts`
  - `build` = `tsc -p .`
  - `start` = `node dist/index.js`
  - `test` = `vitest run`
- **Entry point contract with the installer:**
  - The installer runs `npm ci && npm run build` and starts the daemon with **`node /opt/nicode/server`**, so Node resolves `package.json → "main"`.
  - Shared types are imported by relative path (`../../protocol/types.js`) with tsconfig `rootDir: ".."`, `outDir: "dist"`, and `include: ["src", "../protocol"]`. tsc then emits `dist/server/src/index.js`, which is what `"main"` must point to.
  - The MCP server compiles to `dist/server/src/mcp/approve-server.js`.
  - Keep `package-lock.json` committed.

## Layout
```
server/
  package.json  tsconfig.json  vitest.config.ts
  src/
    index.ts              # load config → start http+ws → write status → graceful shutdown
    config.ts             # zod schema for NICODE_CONFIG json (see below), env file helpers
    log.ts                # pino; redact token/authorization/CLAUDE_CODE_OAUTH_TOKEN
    http.ts               # /health, upgrade → auth → ws; 401 + backoff
    auth.ts               # per-device tokens: sha256 + timingSafeEqual; backoff; reload on SIGHUP/file change
    rpc.ts                # method registry: zod schema + handler; dispatch; error mapping
    events.ts             # broadcast(event, data) to all authed sockets
    status.ts             # read/write status.json (SetupStatus), setState()
    paths.ts              # resolveProject(), resolveInProject() with realpath guard
    modules/
      server.ts           # server.info
      setup.ts            # claudeLogin.*, github.*
      (server.ts)         # auth.devices, auth.revoke, auth.renameDevice
      projects.ts         # list/clone/create/githubRepos
      fs.ts               # list/read/write/rename/delete/search + watcher
      git.ts              # simple-git wrappers
      term.ts             # tmux-backed PTYs
      claude.ts           # RPC surface for sessions
      push.ts             # expo push tokens + send()
    claude/
      session.ts          # ClaudeSession: spawn, stdin writer, stdout JSONL parser, lifecycle
      store.ts            # ~/.nicode/sessions/<id>.jsonl + index.json
      permissions.ts      # pending requests, remember-rules, internal unix-socket server
    mcp/
      approve-server.ts   # stdio MCP server exposing tool `approve` (compiled to dist)
  scripts/
    test-client.html      # browser console: connect, call methods, xterm for term.*, event log
  test/                   # vitest unit tests
```

## Config (`$NICODE_CONFIG`, written by the installer, mode 600)
```jsonc
{
  "version": 1,
  "bindHost": "127.0.0.1",      // 0.0.0.0 for transport=local, tailnet IP for tailscale
  "port": 7878,
  "tokens": [                    // one per paired device; managed by `nicode token …` and auth.*
    { "id": "d_1a2b3c4d", "name": "Pixel 8", "sha256": "hex", "createdAt": "2026-10-12T10:00:00Z" }
  ],
  "transport": "https",         // https | tailscale | local
  "publicHost": "203-0-113-7.sslip.io",
  "user": "dev",
  "projectsRoot": "/home/dev/projects",   // may be any folder on existing servers, e.g. /var/www or /root
  "dataDir": "/home/dev/.nicode",
  "envFile": "/home/dev/.config/nicode/env",       // KEY=VALUE lines; holds CLAUDE_CODE_OAUTH_TOKEN
  "statusFile": "/var/lib/nicode/public/status.json",
  "claudeBin": "/home/dev/.local/bin/claude",
  "appDir": "/opt/nicode",
  "role": "development"          // or "production": Claude may only analyze (read-only); see docs/05
}
```
- `role` is changed by `server.setRole` (fingerprint to leave production), `nicode role …` or the installer's `--role`, and applied on reload without a restart. Re-running the installer keeps the existing role.
- Analyze chats run Claude under bubblewrap (`src/claude/sandbox.ts`); the daemon probes it at startup (`analyzeIsolation` in `server.info`). Their Claude state lives in `<dataDir>/analyze-claude`, scratch files in `<dataDir>/scratch/<sessionId>`, read-only DB URLs in `<dataDir>/analyze-db.json`, and deploy history in `<dataDir>/deploys.json`.
- Every config write (pair, revoke, rename) is atomic: tmp file + rename, keeping mode 600 and the owner.
- **Reload:** on SIGHUP (`ExecReload` in the unit, used by `nicode token add/revoke`) and on `fs.watch` of the config file, re-read `tokens`, and close sockets whose device no longer exists (WebSocket close code 4401).
- The env file is also loaded by systemd. When the daemon writes a new token there, it also sets `process.env` so child processes get it without a restart.

## Startup
1. Load and validate the config. Ensure `dataDir/{sessions,tmp}` exist.
2. Compute the setup state. Claude is logged in if **`~/.claude/.credentials.json` exists (normal `/login`) or `CLAUDE_CODE_OAUTH_TOKEN` is in env/envFile** → `ready`; otherwise `needs_claude_login`. Re-check this whenever `server.info` is called, because the user may have logged in over SSH meanwhile. Write it to `statusFile` via `status.setState()`, preserving the installer's `steps`.
3. Start the internal unix-socket server (`dataDir/internal.sock`, mode 600), then the HTTP/WS server, then the control socket (`dataDir/control.sock`, mode 600; `src/control.ts`) for `nicode deploy` and hosting panels. It only dispatches an allowlist of methods (see 05).
4. On SIGTERM: stop accepting connections, SIGINT running Claude processes, flush stores, close PTY clients (**don't** kill tmux sessions), and exit within 5 s.

## RPC core
- `rpc.register(name, zodSchema, handler)`. Handlers receive `(params, ctx)`, where `ctx = { socket, log }`.
- Throw `RpcError(code, message, data?)` for expected errors. Anything else becomes `internal`, logged with its stack, and the message sent to the client is generic.
- Setup gating (see 05): if the method starts with `claude.` and the state isn't `ready` → `setup_required`.
- Heartbeat: ping every 25 s and terminate sockets that don't answer.
- Validate all paths through `paths.ts`. Only use `execFile`/`spawn` with argument arrays, **never shell strings** built from params.

## Setup module: logins driven by the app
**Claude (`setup.claudeLogin.start`/`submit`)**
1. Spawn `node-pty` with `claudeBin setup-token`. Use `cols: 500` so the URL doesn't wrap, `name: xterm-256color`, `cwd: $HOME`, and an env without `CLAUDE_CODE_OAUTH_TOKEN`.
2. Accumulate output and strip ANSI. Resolve `start` with the first `https://\S+` URL (prefer one containing `oauth` or `claude.ai`).
3. `submit(code)`: write `code + "\r"` and wait for `/sk-ant-oat[0-9A-Za-z_\-]+/`. On a 60 s timeout, fail with the last 500 characters of output in `error.data` (secrets redacted).
4. Save the token to the env file (replacing the line, keeping mode 600) and set `process.env`.
5. Verify by running `claudeBin -p "Reply with just OK" --output-format json` with the token in env and a 60 s timeout, and check that `result` contains OK.
6. `status.setState('ready')` and broadcast `setup.progress`.
7. Log the step, never the token.

`setToken(token)` skips steps 1–3.

**GitHub (`setup.github.start`/`poll`)**
- PTY: `gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key`, with env `BROWSER=true` and `GH_PROMPT_DISABLED` unset.
- Parse `/([A-Z0-9]{4}-[A-Z0-9]{4})/` for the code. When it says "Press Enter", write `\r`.
- `verificationUrl` = `https://github.com/login/device`.
- `poll`: `done` when the process exits 0. Then run `gh auth setup-git`. If git `user.name`/`user.email` are unset, fill them from `gh api user`; when the email is null, use `<id>+<login>@users.noreply.github.com`.

## Claude sessions (the core)
Each session (`claude/session.ts`) owns at most one CLI process.

**Spawn**
```
<claudeBin> -p
  --input-format stream-json --output-format stream-json --verbose
  --permission-mode <default|acceptEdits|plan|bypassPermissions>
  [--model <alias or id>]
  [--resume <sessionId>]                        # when the process is restarted
  [--session-id <uuid>]                         # on first start, so our id == Claude's id
  --mcp-config <dataDir/tmp/mcp-<sessionId>.json>
  --permission-prompt-tool mcp__nicode__approve
```
- Run it with `cwd = projectPath`, the env from `process.env` plus the env file, and `stdio: pipe` (no PTY needed).
  - Only set `CLAUDE_CODE_OAUTH_TOKEN` when the env file has one. Otherwise the CLI uses the user's own `/login` credentials, which is how already-logged-in servers work with no extra login.
  - When running as **root**, Claude Code refuses `bypassPermissions`. Report `bypassAvailable: false` in `server.info` and reject that mode with `bad_request`.
- **Verify the flags against `claude --help` for the installed version at M4.** If `--session-id` isn't supported, use a temporary id, map it to the `session_id` from the `system/init` event, and rename the store.
- MCP config file (mode 600):
  ```json
  {"mcpServers":{"nicode":{"command":"<process.execPath>","args":["<dist>/mcp/approve-server.js"],
    "env":{"NICODE_SOCKET":"<dataDir>/internal.sock","NICODE_SECRET":"<random per daemon start>","NICODE_SESSION_ID":"<id>"}}}}
  ```

**Input:** one JSON object per line on stdin per user turn:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```
Before writing, append and broadcast the daemon marker `{"type":"nicode","subtype":"user_turn","text":"<prompt>"}`.

**Output:** split stdout on `\n` and `JSON.parse` each line. Non-JSON lines become `{"type":"nicode","subtype":"stderr","text":…}`. For each event:
- `seq = ++lastSeq`. Append `{seq, ts, event}` to `sessions/<id>.jsonl`, update `index.json`, and broadcast `claude.event`.
- `result` → state `idle`, and send a push notification ("✅ <project>: <first 80 chars of result>").
- Collect stderr into a ring buffer for error reporting.

**Lifecycle**
- States: `running` while a turn is in flight, `awaiting_permission` while a permission request is pending, `idle` after `result`, and `error` when the process exits non-zero mid-turn.
- Keep the process alive between turns. After **30 min** idle, kill it. The next `claude.send` respawns it with `--resume <id>` and the current mode/model.
- `claude.interrupt` → SIGINT. If it hasn't exited within 5 s → SIGTERM. Emit the marker `interrupted`, then state `idle`.
- `claude.setMode` → store the new mode/model. If a process is running and idle, kill it so the next turn respawns with the new flags.
- At most **3 concurrently running** sessions (configurable). Beyond that, `busy`.

**Store**
- `sessions/<id>.jsonl` (append-only) and `sessions/index.json` (`ClaudeSessionSummary[]`).
- The `title` is the first prompt truncated to 80 characters.
- `claude.history` reads the JSONL file and filters on `seq > sinceSeq`, with a limit.

## Permission bridge
1. Claude calls the MCP tool `approve` with `{ tool_name, input, tool_use_id? }`.
2. `approve-server.ts` (stdio, via `@modelcontextprotocol/sdk`) POSTs `{sessionId, toolName, input}` to the unix socket with the secret header, then waits for the response, which may take up to 10 minutes. Set the HTTP timeout to match.
3. The daemon checks the **remember rules** (`dataDir/permissions.json`: `{ [projectPath]: { tools: string[], bashPrefixes: string[] } }`). On a match it allows immediately.
4. Otherwise it creates a `PermissionRequest` (expires in 10 min), sets the session state to `awaiting_permission`, broadcasts `claude.permission.request`, and sends a push notification ("🔐 Approve Bash: npm test").
5. `claude.permission.respond` resolves the pending request, or the timeout denies it. If `remember`, the rule is stored.
6. The tool returns **text content** containing JSON:
   - allow: `{"behavior":"allow","updatedInput":<input or edited input>}`
   - deny: `{"behavior":"deny","message":"<reason or 'Denied from niCode'>"}`
7. Broadcast `claude.permission.resolved` and set the state back to `running`.

## Terminals
- `term.open {cwd, name}` → session name `nicode-<slug(name)>`.
  - Spawn node-pty with `tmux new-session -A -s <name> -c <cwd>`, `name: xterm-256color`, the requested cols/rows, and `env.LANG=C.UTF-8`.
- Output is batched every 16 ms or at 32 KB and sent as base64 in `term.data`. Each terminal keeps a 256 KB ring buffer for `term.attach` replay.
- `term.list`: in-memory PTYs plus `tmux list-sessions -F '#S'` entries with the `nicode-` prefix. The latter survive daemon restarts because the unit uses `KillMode=process`. Attaching to one spawns `tmux attach -t <name>`.
- `term.close {kill}`: kills the PTY client. With `kill`, also runs `tmux kill-session -t <name>`.

## Files and git
- `paths.ts`:
  - `resolveProject(p)`: `realpath(p)` must start with `realpath(projectsRoot) + '/'`.
  - `resolveInProject(root, rel)`: reject absolute paths and `..` escapes, then realpath the parent and check again (this blocks symlink escapes).
- `fs.list`:
  - Read the directory and skip `.git`.
  - Mark `ignored` with a single batched `git check-ignore --stdin -z` when inside a repo.
  - Sort directories first.
  - Subscribe this socket to `fs.changed` for the project (chokidar, ignoring `node_modules` and `.git`, 300 ms debounce, watcher closed when no sockets remain).
- `fs.read`/`fs.write`: as described in 05. Writes go to a tmp file then rename, and preserve the file mode.
- `fs.search`: `rg --json --max-count 5 --max-columns 300 [-F unless regex] [-g glob] -- <query>` in the project, capped at `maxResults` (200).
- `git.*`:
  - Use `simple-git` with `baseDir` = the resolved project.
  - `status` maps to `GitStatus`.
  - `push`/`pull` capture output, with a 120 s timeout and `GIT_TERMINAL_PROMPT=0`.
- `projects.githubRepos`: `gh repo list --json nameWithOwner,url,isPrivate,updatedAt --limit <n>` (also include repos from orgs if possible).
- `projects.clone`: `gh repo clone <nameWithOwner|url> <projectsRoot/name>` when gh is authed, otherwise `git clone`.

## Push
- `push.register` stores tokens in `dataDir/push.json`, deduplicated.
- `send(title, body, data)` uses `expo-server-sdk`. Drop tokens that come back with a `DeviceNotRegistered` receipt.
- `data` = `{ kind: 'result'|'permission', sessionId, requestId? }`, which the app uses to deep-link.
- Throttle to at most one result notification per session per 30 s.

## Security checklist (verify at M8)
- [ ] Binds only to `bindHost`. On `https`, a public request to `:port` fails (ufw blocks it and the daemon listens on 127.0.0.1).
- [ ] Token compared via the SHA-256 hash and `timingSafeEqual` against every device entry. Revoking a device closes its sockets. Backoff after 5 failures per IP (1 s → 5 min).
- [ ] No params ever reach a shell string. Paths are guarded with realpath. Symlink-escape test passes.
- [ ] Logs never contain tokens. pino `redact` covers headers and env, and the PTY output of the login flows is masked.
- [ ] The internal socket has mode 600 and requires the secret.
- [ ] The control socket has mode 600, answers only its allowlist, and its callers can't pass production guards.
- [ ] The daemon runs as the dev user and never calls sudo itself.

## Milestones and acceptance
| # | Build | Acceptance |
|---|---|---|
| M1 | config, log, http `/health`, ws auth + backoff, rpc core, `server.info`, status.ts | `curl /health` → ok. `test-client.html` connects with the token and gets `server.info`. A wrong token → 401. Unit tests: auth, rpc validation |
| M2 | setup module (Claude + GitHub login, setToken); device auth (`/pair`, `/auth/challenge`, signed login, expiring browser tokens) | From test-client: start → URL shown → paste code → `status.json` state becomes `ready`. Pairing with a one-time code; a replayed signature, a used or expired code, or a legacy permanent token → 401; revoke → that socket closes with 4401. A server already logged in via `claude /login` starts as `ready` |
| M3 | terminals | test-client xterm: open, run `htop`, resize, reload the page → attach replays. Restart the daemon → `term.list` shows the tmux session |
| M4 | Claude sessions (no permission tool yet: `--permission-mode acceptEdits`) | start → streamed events; send a second turn; interrupt; kill the process → the next send resumes with history intact; `claude.history` paging |
| M5 | permission bridge + remember rules | Mode `default`: an Edit triggers `permission.request`; allow → the file changes; deny with a message → Claude acknowledges; the 10-min timeout denies (test with a 5 s override) |
| M6 | projects, fs, git | Clone a repo, list/read/write with a conflict test, search, status/diff/stage/commit/push. Path traversal + symlink tests fail with `forbidden` |
| M7 | push | Register a token from the app (or an Expo push tool), finish a turn → notification received; a permission request → notification |
| M8 | integration | `sudo nicode update` on a droplet builds and restarts cleanly. Through Caddy: `wss://<host>/ws` works, `/setup/status` works, and `/internal` isn't reachable. Security checklist done |

## Test client (`scripts/test-client.html`)
A single static file using xterm.js from the jsDelivr CDN. Fields for URL and token (the token is sent through the `nicode.<token>` subprotocol). Panels:
1. a JSON request box with an event log
2. buttons for common calls
3. an xterm panel bound to `term.*`
4. a minimal Claude chat that prints raw events

Open it locally in a browser against `ws://localhost:7878/ws` during development.

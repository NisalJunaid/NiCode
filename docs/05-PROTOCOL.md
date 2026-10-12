# 05 — niCode wire protocol

The contract between the **daemon** (`server/`) and the **app** (`app/`). The types live in [protocol/types.ts](../protocol/types.ts); this document covers semantics. **Change both in the same commit** and bump `PROTOCOL_VERSION` on breaking changes.

## Endpoints

| Endpoint | Served by | Auth | Purpose |
|---|---|---|---|
| `GET /health` | daemon | none | `{"ok":true,"version":"x.y.z","state":"ready"}`, used for liveness checks by the installer and app |
| `GET /setup/status?sid=<setupId>` | Caddy (static file) | setup id in query | Live install progress (`SetupStatus`), readable before the daemon exists |
| `POST /pair` | daemon | one-time pairing code | Registers a phone's public key (see Authentication) |
| `GET /auth/challenge` | daemon | none (rate-limited) | A single-use login nonce, valid for 60 s |
| `GET /ws` (upgrade) | daemon | signed challenge (phones) or short-lived token (browser) | Everything else |
| `POST /permission` on the **unix socket** `<dataDir>/internal.sock` | daemon | socket file mode 600, plus the `X-Nicode-Internal` secret | Used by the MCP approve tool (see 02). It isn't on the TCP port, so Caddy can never proxy it |

Transport by mode: `https` → `wss://<ip-dashed>.sslip.io/ws` (Caddy terminates TLS). `local` → `ws://<lan-ip>:<port>/ws`. `tailscale` → `ws://<tailnet-ip>:<port>/ws`.

## Authentication
There are no reusable passwords for phones. Each phone holds a private key in its secure hardware (Android Keystore / iOS Secure Enclave), unlocked by fingerprint or face, and proves possession of it on **every** connection.

**Pairing (once per phone)**
1. On the server, `nicode pair [name]` creates a **one-time code** (10 characters, shown as `XXXXX-XXXXX`). It is stored hashed and expires after **10 minutes**. The command prints a QR code for `nicode://pair?h=<host>&p=<port>&s=<https|http>&c=<code>&n=<server name>`.
2. The app scans the QR code (or the user types host and code), creates a key pair in secure hardware, and calls `POST /pair` with `PairRequest {code, deviceName, alg, publicKey}`:
   - `alg` is `RS256` (what `react-native-biometrics` creates), `ES256`, or `Ed25519`
   - `publicKey` is base64 DER (SPKI, or PKCS#1 for RSA on iOS), raw Ed25519/P-256 bytes, or PEM
3. The daemon checks and **consumes** the code, then stores the device `{id, name, alg, publicKey}`. Response: `PairResponse {deviceId, deviceName, hostname, publicHost}`. A wrong or expired code returns 401 and counts towards the per-IP backoff. Re-pairing the same public key keeps the existing device record.

**Login (every WebSocket connection)**
1. `GET /auth/challenge` returns `{nonce, expiresAt}`. The nonce is random, valid for 60 s, and **single use**.
2. The app signs the UTF-8 bytes of `authMessage(nonce, deviceId)` = `nicode-auth:v1:<nonce>:<deviceId>`. Signing unlocks the key with biometrics (RSASSA-PKCS1-v1_5/SHA-256 for RS256, ECDSA/SHA-256 for ES256 in DER or raw form, Ed25519 as-is).
3. The app opens `/ws` with `Authorization: Signature deviceId="<id>", nonce="<nonce>", sig="<base64>"` (`signatureHeader()` in types.ts). The daemon consumes the nonce **before** verifying, so a captured header can never be replayed.

**Biometric policy (app side):** a biometric prompt on app open or unlock, then a grace period of a few minutes during which reconnects sign silently. After the grace period, or when the app was backgrounded longer than that, the next connection asks again.

**Browser test console only: short-lived tokens.**
- Create one with `nicode token add <name> --expires 1h` (default 1 hour, maximum 30 days).
- Send it as `Authorization: Bearer <token>`. Browsers can't set headers, so the console instead offers the subprotocols `['nicode', 'nicode.<token>']`; the daemon reads the token from the second and selects `nicode`, so the token is never echoed back.
- Tokens are stored hashed. When a token expires, its sockets are closed within about 25 s.
- **Tokens without an expiry (from older versions) are never accepted.** The installer removes them on update.

**Device management**
- `config.json → devices[]` (older configs called it `tokens`; they are migrated on load) and `pairingCodes[]`.
- The daemon reloads both on SIGHUP (`systemctl reload nicode`, which the CLI sends) and when the config folder changes.
- Revoking a device closes its open sockets with code 4401.
- From the app: `auth.devices`, `auth.revoke`, `auth.renameDevice`.
- On the server: `nicode token list | revoke <id|name> | revoke-all`.

**Failures** return HTTP 401 before the upgrade. Per-IP exponential backoff starts after 5 failures (1 s up to 5 min); the client IP comes from `X-Forwarded-For` **only** when the TCP peer is 127.0.0.1. A successful login resets it.

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

While `SetupStatus.state` is `needs_claude_login`, only these methods are allowed: `server.info`, `setup.*`, `auth.*`, `push.register`, `projects.*`, `fs.*`, `git.*`, `term.*`. `claude.*` returns `setup_required`.

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
- **Images**: `claude.start` and `claude.send` accept `images: ImageInput[]` (up to 4; jpeg/png/webp/gif; ≤ 5 MB each as base64 without a `data:` prefix). They reach Claude as image blocks before the text. History keeps only `imageCount` on the `user_turn` marker, never the image data. The app resizes images to ≤ 1568 px JPEG before sending.
- **`claude.interrupt`**: sends SIGINT. The session goes to `idle` once the process settles.
- **`claude.setMode`**: takes effect on the next turn (the daemon respawns with `--resume` and the new flags if needed).
- **`claude.history`**: returns events with `seq > sinceSeq` (all if omitted), up to 2000 per call. The client pages by calling again with the returned `lastSeq`.
- **`claude.permission.respond`**:
  - `remember: true` stores an allow rule for the project: the tool name, or for `Bash` the first word of the command, such as `npm`.
  - `updatedInput` lets the user edit the input before allowing (for example, tweak a command).
  - `deny` with a `message` is passed back to Claude as the reason.
- **`push.register`**: idempotent. It stores the Expo push token with optional `prefs` (`PushPrefs`: approvals, finished, appCrashes, siteDown; all on by default). Each notification carries `data.kind` (`permission`, `result`, `app`, `site`, `test`), and phones only get the kinds they want.
  - `push.test` sends a test notification to every registered phone and reports Expo errors.
  - **Watchers** run while at least one phone is registered:
    - a pm2 app turning `errored`, or restarting ≥3 times in 5 minutes (checked every 30 s);
    - a niCode-managed site failing two HEAD checks in a row, and again when it is back up (checked every 5 min).

    Each alert is sent at most once per hour, on the Android channel `alerts`.

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

## Sites (websites & domains, nginx)
Methods `sites.*` manage nginx sites on the server. The daemon needs root or passwordless sudo, and nginx. Caddy-based servers report `supported: false` for now.
- **`sites.status`**: `supported`, the web server, the server's public IP, certbot presence, and installed php-fpm versions (from `/run/php/php*-fpm.sock`).
- **`sites.list`**: every file in `sites-available`, with enabled state (via `sites-enabled`), parsed domains, kind, root or proxy port, linked project (when the root is inside `projectsRoot`), and HTTPS with certificate expiry.
  - `managed` = created by niCode (marker comment).
  - `protected` = niCode's own site or `default`; these are never changed.
- **`sites.checkDns {domain}`**: the domain's A records compared with the server IP.
- **`sites.detect {projectPath}`**: suggests kind, webRoot and port (Laravel → php `public/`; Next/Nuxt/Express → proxy with `PORT` from `.env` or 3000; Vite/React → spa `dist/`; and so on).
- **`sites.create`** (`SiteCreate`): steps `folder → config → enable → test → reload → certbot`, each reported live as a `sites.progress {opId, step, status, detail}` event.
  - A failed `nginx -t` removes the new site again.
  - A certbot failure leaves the site working on http; the response still succeeds, and the `certbot` step is reported as failed with a hint.
- **`sites.setEnabled`**: toggles the `sites-enabled` symlink, runs `nginx -t` (reverting on failure), then reloads.
- **`sites.enableHttps`**: runs certbot `--nginx --redirect` for the site's domains, installing certbot if it's missing.
- **`sites.remove`**: managed sites only. Removes the config, the enabled link and the certificate. **Project folders are never deleted.**

## Apps & tasks (pm2)
Methods `apps.*` keep project apps running with pm2 as the daemon's user (`PM2_HOME=~/.pm2`). Apps get a clean environment (PATH, HOME, LANG and so on, plus `PORT` and your variables); daemon secrets are never passed on.
- **`apps.status`**: Node and pm2 versions, and whether pm2 starts on boot (`systemctl is-enabled pm2-<user>`).
- **`apps.setup {opId?}`**: installs pm2 globally (root or passwordless sudo), runs `pm2 startup systemd`, then `pm2 save`. Progress comes as `tasks.step` events.
- **`apps.list`**: every pm2 process: status, CPU, memory, uptime, restarts, cwd, linked project, port (from its `PORT` env) and whether that port answers. `managed` = started by niCode.
- **`apps.startOptions {projectPath}`**: start scripts from package.json (`start:prod` > `start` > `serve` > `preview`), a suggested script or command (node entry files, FastAPI via uvicorn), the port from `.env`, and whether there is a `build` script.
- **`apps.create`** (`AppCreate`): optional install + build, then `pm2 start` (npm script or a plain command with `--interpreter none`), `pm2 save`, and a wait for the port. Steps and output stream as `tasks.step` / `tasks.output`.
- **`apps.action {name, action}`**: start / stop / restart / delete, each followed by `pm2 save`.
- **`apps.logs {name, lines?}`**: the last lines of stdout + stderr.
- **`apps.deploy {name, opId?}`**: `git pull` → install → build → `pm2 reload` (no downtime) → port check.
- **`tasks.list {projectPath}`**: one-tap tasks found in the project: git pull, install (npm/pnpm/yarn/composer), package.json scripts (not dev/watch/serve/start or pre/post hooks), Laravel artisan commands.
- **`tasks.run {projectPath, taskId, opId?}`**: runs a listed task **by id only** (the client never sends a command line) and returns `{code, output}`; output streams as `tasks.output {opId, chunk}`. Times out after 30 minutes.

## Logs
- **`logs.sources {projectPath?}`** returns a catalog of `LogSource {id, label, group, detail, projectPath}` built on the server:
  - nginx access and error logs per enabled site (`access_log` / `error_log`) plus the global ones;
  - pm2 output and error logs per app (newest file in `~/.pm2/logs`);
  - Laravel `storage/logs/laravel*.log` (newest);
  - the niCode daemon (`journalctl -u nicode`);
  - `/var/log/syslog`.

  With `projectPath`, only that project's logs are listed.
- **`logs.tail {id, lines≤2000, filter?}`** → `{text}`. Logs are read **by id only**, so the client never sends a path. Files the daemon can't read go through root (`tail` via sudo). The filter is a case-insensitive substring.
- **`logs.follow {id}`** → `{followId}`. New text arrives as `logs.data {followId, chunk}` events.
  - Readable files are polled every second (rotation is handled); otherwise `tail -F` / `journalctl -f` run as root.
  - `logs.unfollow {followId}`. Follows end automatically when the connection closes (max 4 per connection).

## Live preview
Preview a project's **dev server**, a **running app** (any port), or a **linked domain** inside the app.
- **Port previews** get their own address, `p<port>.<ip-dashed>.sslip.io`, so the page runs at the root of its own origin and absolute asset paths keep working.
  - `preview.open {port, opId?}`, on first use per port: writes an nginx site (`nicode-preview-<port>.conf`; hidden from `sites.list`) that proxies to the daemon, reloads nginx, and gets a certificate. Progress comes as `tasks.step` (`check`, `site`, `https`).
  - It returns a **one-time link** `…/__nicode/auth?t=<token>` (HMAC, 2 minutes, single use, bound to the port).
- **The gate in the daemon:**
  - Opening the link sets an `HttpOnly; Secure; SameSite=Lax` cookie valid for 12 h **for that preview host only**.
  - Requests without it get 401. With it, requests and websocket upgrades (hot reload) are proxied to `127.0.0.1:<port>`, with `Host: localhost:<port>` and `X-Forwarded-Host`; the cookie is stripped before forwarding.
  - The daemon's own port can't be previewed.
- `preview.list` and `preview.close {port}` (removes the nginx site + certificate). `preview.status` → `{supported, reason?}`, which needs nginx + root/sudo like Sites.
- **Dev servers:**
  - `preview.devOptions {projectPath}` shows the command that will run: `dev` > `develop` > `start:dev` > `serve` > `start`, with framework port/host flags for Next, Nuxt, Astro, Angular and Vite; Laravel uses `php artisan serve`.
  - `preview.devStart {projectPath, opId?}` runs it on a free port from 5170, bound to 127.0.0.1, and resolves once the port answers (max 2 min). Output streams as `tasks.output` with the dev server's `opId`.
  - `preview.devStatus` → `{dev, output}`; `preview.devStop`.
  - Limits: one per project, up to 3 at once. A dev server stops after 2 h without preview traffic, and when the daemon stops.
- **Domain previews** are loaded by the app directly from `https://<domain>`.

## Reconnect
1. Reconnect with backoff (0.5 s → 30 s max), and immediately when the app returns to the foreground.
2. `server.info`.
3. For each open chat: `claude.history { sessionId, sinceSeq: lastSeenSeq }`, then append.
4. For each open terminal: `term.attach`, write the `replay` into xterm after clearing it.
5. `claude.permission.pending` to show any approvals that arrived while disconnected.

## Pairing URI
```
nicode://pair?h=<host>&p=<port>&s=<https|http>&c=<one-time code>&n=<server name>
```
Produced by `nicode pair` and by the installer's final screen, and parsed by `parsePairingUri()` in `types.ts`. Seeing it after it was used, or after 10 minutes, gives no access. Droplets the app creates itself are pre-paired with the phone's public key through cloud-init (`NICODE_DEVICE_PUBKEY`), so no code is needed there.

## `status.json` (SetupStatus)
Written by the installer ([installer/lib/status.sh](../installer/lib/status.sh)) during the install, and afterwards by the daemon (the file is owned by the dev user).

```json
{"version":1,"state":"installing","step":"node",
 "steps":[{"id":"system","title":"System packages & swap","status":"done","detail":"upgraded;installed: jq tmux"}, …],
 "host":"203-0-113-7.sslip.io","transport":"https","updatedAt":"2026-10-12T10:00:00Z","error":null}
```
`state`: `installing` → (`base_ready` | `needs_claude_login` → `ready`) or `error`. Step `status`: `pending | running | done | skipped | failed`.

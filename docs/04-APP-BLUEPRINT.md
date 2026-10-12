# 04 — Mobile app blueprint (`app/`)

> **Audience:** Claude Code on Windows, building `app/` from scratch. Read [00-OVERVIEW](00-OVERVIEW.md) and [05-PROTOCOL](05-PROTOCOL.md) first. Toolchain setup is in [03-LOCAL-DEV-SETUP](03-LOCAL-DEV-SETUP.md). Import the shared types from [protocol/types.ts](../protocol/types.ts); never copy them.

## Kickoff prompt (paste into Claude Code at the repo root, on Windows)
```
Read CLAUDE.md, docs/00-OVERVIEW.md, docs/04-APP-BLUEPRINT.md and docs/05-PROTOCOL.md.
Build app/ milestone by milestone (M1 → M9) as specified. After each milestone run
`npx tsc --noEmit` and `npx expo-doctor`, describe how to verify it on the Android emulator, then stop
and summarise before moving on. Never change the wire protocol without updating
protocol/types.ts and docs/05-PROTOCOL.md together.
```

## Product in one paragraph
One app, three ways to add a server. First launch offers:
1. **Connect to my server** (the main path). Enter the SSH connection details for a server you already have. If niCode is already on it, the app just pairs; if not, the app installs it. If Claude is already logged in on that server, there is **no login step**.
2. **Pair with QR / code.** No SSH at all: scan the QR from `nicode pair` on the server, or type the host and token.
3. **Create a server on DigitalOcean.** Paste an API token; the app creates and provisions a droplet.

All three end on the same host screen. A Claude login or GitHub login screen appears only when the server reports it isn't logged in yet. Afterwards you pick a project and work in four tabs: **Chat** (Claude Code agent), **Files**, **Changes** (git), and **Terminal**. Push notifications tell you when the agent finishes or needs approval.

## Stack
- **Expo SDK (latest stable)** with expo-router, TypeScript strict, and the New Architecture. Run it with a **development build** (`expo-dev-client`), not Expo Go, because it uses native modules.
- Dependencies (install with `npx expo install` so versions match the SDK):
  - Expo modules: `expo-dev-client`, `expo-secure-store`, `expo-notifications`, `expo-device`, `expo-web-browser`, `expo-clipboard`, `expo-camera`, `expo-crypto`, `expo-haptics`, `expo-build-properties`, `expo-localization`
  - UI and storage: `react-native-webview`, `react-native-mmkv`, `react-native-reanimated`, `react-native-gesture-handler`, `@gorhom/bottom-sheet`
  - State and rendering: `zustand`, `react-native-markdown-display`
  - SSH: `@dylankenneally/react-native-ssh-sftp`, only for the "Use my server" path. If it doesn't build on the current SDK, isolate it behind `src/provision/ssh.ts` and treat the SSH path as optional until a working fork is found.
- Shared protocol:
  - `tsconfig.json` → `"paths": { "@protocol/*": ["../protocol/*"] }`
  - `metro.config.js` → `config.watchFolders = [path.resolve(__dirname, '../protocol')]`
  - Expo's `experiments.tsconfigPaths: true` in app config.

## Setup commands (run from the repo root)
```powershell
npx create-expo-app@latest app --template default
cd app
npx expo install expo-dev-client expo-secure-store expo-notifications expo-device expo-web-browser expo-clipboard expo-camera expo-crypto expo-haptics expo-build-properties expo-localization react-native-webview react-native-mmkv react-native-reanimated react-native-gesture-handler @gorhom/bottom-sheet
npm i zustand react-native-markdown-display @dylankenneally/react-native-ssh-sftp
npx expo run:android        # builds + installs the dev client on emulator/USB phone
```
Remove the template's example screens.

## Layout
```
app/
  app.config.ts                 # name niCode, scheme "nicode", plugins, extra.nicodeRepo, variants
  eas.json
  app/                          # expo-router routes
    _layout.tsx                 # providers: GestureHandler, BottomSheet, theme, RpcProvider, notifications
    index.tsx                   # → /onboarding if no hosts, else /hosts
    onboarding/
      index.tsx                 # Connect to my server (SSH) | Pair with QR/code | Create on DigitalOcean
      do-token.tsx              # paste PAT, validate, explain scopes
      do-plan.tsx               # auto-picked plan, editable (region, size, name)
      ssh.tsx                   # connection details → probe → pair or install (see below)
      pair.tsx                  # paste nicode://pair URI, or host + token by hand
      progress.tsx              # live timeline (shared by both paths), resumable
      claude-login.tsx          # open URL → paste code → verify
      github-login.tsx          # device code (optional, skippable)
      done.tsx
    pair-scan.tsx               # expo-camera QR → parsePairingUri
    hosts/index.tsx             # host list with status dots
    hosts/[hostId]/index.tsx    # projects list + clone from GitHub + new project
    hosts/[hostId]/server.tsx   # status, update, restart, rotate token, destroy droplet
    p/[hostId]/[project]/_layout.tsx    # tabs
    p/[hostId]/[project]/chat.tsx       # session list → session view
    p/[hostId]/[project]/files.tsx
    p/[hostId]/[project]/changes.tsx
    p/[hostId]/[project]/terminal.tsx
  src/
    rpc/client.ts               # NicodeClient (see below)
    rpc/RpcProvider.tsx         # one client per host; hooks useRpc(hostId), useEvent(name, fn)
    do/api.ts                   # DigitalOcean REST client
    do/regions.ts               # timezone → region preference
    provision/machine.ts        # provisioning state machine (persisted)
    provision/cloudInit.ts      # template (copy of installer/cloud-init.yaml.tmpl) + render()
    provision/ssh.ts            # SSH install runner
    state/hosts.ts              # zustand + MMKV; tokens in SecureStore
    state/sessions.ts           # per-session event list, lastSeq, status, pending permissions
    state/terminals.ts
    components/chat/*           # MessageList, UserBubble, AssistantText, ThinkingBlock, ToolCard,
                                # BashCard, EditDiffCard, WriteCard, TodoCard, ResultFooter,
                                # PermissionSheet, Composer, ModeChips, ModelPicker
    components/diff/UnifiedDiff.tsx     # native diff renderer for git.diff + Edit cards
    components/ExtraKeysBar.tsx
    webviews/TerminalView.tsx   # WebView + bridge
    webviews/EditorView.tsx
    webviews/generated/         # terminalHtml.ts, editorHtml.ts (generated, committed)
    theme.ts
  web/                          # Vite project → single-file HTML for the WebViews
    terminal/index.html + main.ts       # xterm.js + fit + web-links addons
    editor/index.html + main.ts         # CodeMirror 6 + lang packs + @codemirror/merge
    vite.config.ts                      # vite-plugin-singlefile, two inputs
  scripts/embed-web.mjs         # build web/ → write src/webviews/generated/*.ts (export default string)
```

## Hosts and secrets
- `Host = { id, name, kind: 'ssh'|'paired'|'do', baseUrl /* https://x.sslip.io or http://ip:port */, deviceId, sshHost?, sshPort?, sshUser?, dropletId?, region?, createdAt }` is stored in MMKV.
- The **daemon token** goes in SecureStore under `host.<id>.token`. The **DO token** goes under `do.token`, with a "Forget DO token" action in settings.
- **SSH credentials** are used for pairing and install and then forgotten, **unless** the user turns on "Remember SSH login for maintenance". In that case they go in SecureStore under `host.<id>.ssh` and enable Server-screen actions (update, restart, repair) even when the daemon is down.
- The device name sent when pairing is `Device.deviceName` (expo-device), for example "Pixel 8". It shows up in `nicode token list` and in the app's Devices list.
- Tokens are generated with `Crypto.getRandomBytes(32)` → hex, and setup ids with 16 bytes.

## RPC client (`src/rpc/client.ts`)
- `new WebSocket(wsUrl, undefined, { headers: { Authorization: 'Bearer ' + token } })`.
- `call<M extends MethodName>(method, params): Promise<MethodResult<M>>` with incrementing ids, a 30 s timeout (overridable per call), and errors rejected as `RpcError`.
- `on<E extends EventName>(event, fn)` returns an unsubscribe function.
- **Reconnect:**
  - Exponential backoff from 0.5 s to 30 s. When `AppState` becomes `active`, reconnect immediately.
  - On open: `server.info`. If the protocol version doesn't match, show a banner.
  - Then `claude.history{sinceSeq}` for every loaded session, `term.attach` for mounted terminals, and `claude.permission.pending`.
- Expose `status: 'connecting'|'open'|'closed'` in a store, shown in the header (green, amber or red dot).

## Provisioning: DigitalOcean path
**`src/do/api.ts`** uses `https://api.digitalocean.com/v2` with `Authorization: Bearer <PAT>`. Functions:
- `getAccount()` (validates the token and shows the email and droplet limit)
- `listRegions()`, `listSizes()`, `listSshKeys()`
- `createDroplet(body)`, `getDroplet(id)`, `deleteDroplet(id)`

Handle 401 (bad token), 403 (missing scope), 422 (shows DO's message) and 429 (retry after the reset).

**Token help text:** at cloud.digitalocean.com → API → Generate New Token, choose **Custom Scopes**: `droplet` (create, read, delete), `regions:read`, `sizes:read`, `ssh_key:read`, `account:read`, `tag:create`. Full Access also works. The token is only used from the phone.

**Plan auto-pick (`do-plan.tsx`)**:
- name `nicode-<4 random chars>`, image `ubuntu-24-04-x64`
- size `s-2vcpu-4gb` (recommended), with options `s-1vcpu-2gb` (budget) and `s-4vcpu-8gb`; show the monthly price from `/sizes`
- region from `regions.ts`: map `Localization.getCalendars()[0].timeZone`:
  - `America/Los_Angeles`, `America/Vancouver` and other western US/Canada zones → `sfo3`
  - `America/Toronto` → `tor1`
  - any other `America/*` → `nyc3`
  - `Europe/London`, `Europe/Dublin` → `lon1`
  - `Europe/Amsterdam` → `ams3`
  - any other `Europe/*` and `Africa/*` → `fra1`
  - `Asia/Kolkata` → `blr1`
  - any other `Asia/*` → `sgp1`
  - `Australia/*` → `syd1`
  - otherwise `nyc3`

  Pick the first region that is `available` and lists the chosen size.
- `ssh_keys`: all key ids in the account (shown as "Attached for emergency access: N keys"). If there are none, show a notice that DO will email a root password; that is acceptable because the installer doesn't need SSH.
- `monitoring: true`, `tags: ['nicode']`, `user_data: renderCloudInit({ token, setupId, repo, ref, installerUrl })`.

**State machine (`src/provision/machine.ts`)**: persisted in MMKV after every transition, so killing the app resumes exactly where it was.
```
idle → creating            POST /droplets              → save dropletId
     → booting             poll GET /droplets/:id every 5s until status=active and a public v4 IP exists
     → installing          baseUrl = https://<ip-dashed>.sslip.io
                           poll GET {baseUrl}/setup/status?sid=<setupId> every 3s
                           (network/TLS errors are expected for the first ~1–3 min: show "Waiting for the server…")
                           until state ∈ {needs_claude_login, ready, base_ready, error}
     → connecting          open RPC with the token; server.info
     → claudeLogin         (skip if setup.claude)  → claude-login.tsx
     → github              optional → github-login.tsx
     → rotating            auth.rotate → store the new token → reconnect
     → done                create Host; delete the machine record
error states keep { step, message, canRetry }, with buttons:
     Retry step · View status details · Destroy droplet and start over
```
Timeouts: booting 5 min, installing 25 min (after which the app offers to keep waiting or destroy). The progress screen renders `SetupStatus.steps` as a vertical timeline (pending, spinner, done, skipped, failed), with `detail` lines under each step.

**`cloudInit.ts`**: an exact copy of [installer/cloud-init.yaml.tmpl](../installer/cloud-init.yaml.tmpl). `render()` replaces `{{TOKEN}}`, `{{SETUP_ID}}`, `{{DEVICE_NAME}}` (strip everything except letters, digits, space and `._-`, because the file is sourced by bash), `{{REPO}}`, `{{REF}}`, `{{INSTALLER_URL}}`. Repo, ref and installer URL come from `app.config.ts → extra` (defaults: `https://github.com/NisalJunaid/NiCode`, `main`, the matching raw URL of `dist/nicode-install.sh`).

## Connect to an existing server (`onboarding/ssh.tsx` + `provision/ssh.ts`)
The equivalent of VS Code Remote-SSH: you give connection details and the app takes care of the server side.

**Form:**
- host (IP or name), port (22), user (default `root`)
- auth: private key (paste, or pick a file) **or** password
- optional *Advanced*: projects folder (`--projects-root`), "Don't reuse root" (`--no-root`)
- toggle: *Remember SSH login for maintenance*

**Flow** (each step is shown as a checklist row):
1. **Connect.** Accept and pin the host key fingerprint (trust on first use; warn if it ever changes).
2. **Probe.** Run:
   ```sh
   command -v nicode >/dev/null && ${SUDO} nicode status --json || echo '{"installed":false}'
   ```
   `${SUDO}` is empty for root. For other users it's `sudo -n`, or `sudo -S -p ''` with the password piped in when `-n` fails. Parse the result into `{installed, daemon, state, scheme, host, port, claudeLoggedIn, githubLoggedIn, projectsRoot, user}` (see `nicode status --json`).
3. **Branch:**
   - **Already installed, daemon active:** run `${SUDO} nicode token add "<device name>" --json` → `{id, token, scheme, host, port}`. Save the Host and connect. **No install and no login**: it's done in seconds. Other paired devices keep working.
   - **Installed, but the daemon isn't active:** offer **Repair** → `${SUDO} nicode update` (streamed), then pair as above.
   - **Not installed:** generate a token and setup id, then run
     ```sh
     curl -fsSL <installerUrl> -o /tmp/nicode-install.sh && ${SUDO} bash /tmp/nicode-install.sh --unattended --token <t> --setup-id <s> --device-name "<device name>" [--projects-root …] [--no-root] 2>&1
     ```
     Stream the output into a log view using the SSH library's shell API. If only `execute` is available, run it under `nohup` and poll. Progress also comes from `https://<host>/setup/status?sid=` like the DO path. The installer automatically **reuses the user who is already logged in to Claude (including root) and the folder holding the existing repos**, so nothing is set up twice.
4. **Connect** over WSS with the token, then `server.info`.
   - `setup.claude === true` → done, with **no Claude login screen**.
   - `false` → the Claude login screen (the only case where a login appears), then GitHub optionally, if `setup.github` is false and the user wants it.
5. No token rotation is needed here: the token never left the SSH channel.

If the server has no public IP (LAN only), the installer picks `local` transport. The app warns that it only works on the same network, or suggests `--transport tailscale`.

## Pair with QR / code (`onboarding/pair.tsx`, `pair-scan.tsx`)
For servers someone has already set up, when you don't want to give the app SSH access:
- On the server, run `nicode pair "My phone"`. It prints a QR code plus a `nicode://pair?...` URI.
- In the app: **Scan QR** (expo-camera) or **paste the URI**, or enter host and token by hand → `parsePairingUri()` → connect → `server.info`. Show the login screens only if the server reports it isn't logged in.
- Also register the `nicode://` scheme, so tapping a pairing link on the phone opens this screen.

## Devices (`hosts/[hostId]/server.tsx`)
Lists `auth.devices` (the current device is marked). Actions: rename, revoke another device, and "Re-key this device" (`auth.rotate`).

## Claude login screen
1. `setup.claudeLogin.start` → `{loginId, url}`.
2. A big "Open Claude login" button → `WebBrowser.openBrowserAsync(url)`.
3. When the browser closes, show a code field with a **Paste** button (expo-clipboard) → `setup.claudeLogin.submit{loginId, code}`, with a spinner labelled "Verifying with Claude…" for up to 90 s.
4. Success → a check mark.
5. A "Having trouble?" link opens the manual fallback: run `claude setup-token` on any computer and paste the `sk-ant-oat…` token → `setup.claudeLogin.setToken`.

## GitHub login screen (skippable)
`setup.github.start` → show `userCode` in a large monospace font with a Copy button → open `verificationUrl` → poll every 3 s. Done → show the login name.

## Chat (`chat.tsx` + `components/chat`)
- **Session list:** `claude.list{projectPath}`, sorted by `updatedAt`, with a state badge. A "New session" button opens the composer, which calls `claude.start`.
- **Session view:** a FlatList (inverted) built from `state/sessions` events, collapsed into render items:
  - `nicode/user_turn` → UserBubble
  - `assistant` → one item per content block: `text` → AssistantText (markdown), `thinking` → ThinkingBlock (collapsed, dim), `tool_use` → ToolCard keyed by the block id
  - `user` with `tool_result` → **merged into** the ToolCard with the same `tool_use_id` (status, output, `is_error` → red)
  - `result` → ResultFooter (duration, turns, cost if present)
  - `system/init` → a model/cwd chip
  - unknown → a collapsed raw JSON row
- **Tool card specializations:**
  - Bash: command plus collapsible output
  - Edit/MultiEdit: `UnifiedDiff` of old_string → new_string with the file path
  - Write: the file path, first 20 lines, and an "Open in Files" link
  - Read/Glob/Grep: compact chips
  - TodoWrite: a checklist
  - Task: a subagent label with its prompt
  - WebFetch/WebSearch: the URL or query
  - default: tool name and JSON input
- **Composer:**
  - Multiline input, Send (disabled while `busy`; queue one message), and **Stop** while running (`claude.interrupt`).
  - **Mode chips:** Ask (`default`), Auto-edit (`acceptEdits`), Plan (`plan`). Show `bypassPermissions` only behind a settings toggle.
  - **Model picker:** Default/Opus/Sonnet/Haiku, sent as CLI aliases.
  - Both go through `claude.setMode`.
- **PermissionSheet:**
  - A bottom sheet triggered by `claude.permission.request` (also via push). It shows the tool and its input, rendered with the same card components (diff for edits, command for Bash; the command is editable → `updatedInput`).
  - Buttons: **Allow**, **Always allow** (shows what will be remembered, such as "Bash: npm *" → `remember: true`), and **Deny** (optional reason).
  - Haptics on arrival.
  - If several requests are pending, show them as a queue.

## Files (`files.tsx`)
- A lazy tree from `fs.list` with ignored entries dimmed and pull-to-refresh, and live updates from `fs.changed`.
- Tapping a file opens EditorView (CodeMirror) in read mode. **Edit** switches to writable. **Save** → `fs.write` with `expectedMtimeMs`. A `conflict` offers "Reload theirs" or "Overwrite".
- A search bar → `fs.search` → results grouped by file; tapping a result opens the file at that line.

## Changes (`changes.tsx`)
- `git.status` shows a staged/unstaged list with the branch and ahead/behind counts.
- Tapping a file → `git.diff{path}` in `UnifiedDiff` (native; use the WebView merge view only for huge diffs).
- Swipe to stage/unstage/discard (discard asks for confirmation).
- Commit box → `git.commit`, then Push/Pull buttons with the output shown in a toast or sheet.
- A branch switcher → `git.branches` / `git.checkout`.

## Terminal (`terminal.tsx`)
- `TerminalView` loads `terminalHtml`. On `ready{cols,rows}` it calls `term.open{cwd: projectPath, name: project, cols, rows}` (or `term.attach` if one is already known).
- `term.data` → `postMessage({type:'write', data})` to the WebView.
- Web `input{data}` → `term.write`. Web `resize{cols,rows}` → `term.resize`.
- **ExtraKeysBar** above the keyboard: Esc, Tab, Ctrl (sticky: the next key becomes `char & 0x1f`), Alt (sticky: prefix `\x1b`), ↑ ↓ ← → (`\x1b[A/B/D/C`), `|`, `~`, `/`, `-`, Home/End, and PgUp/PgDn.
- A tab strip for several terminals (`term.list`) and a "New terminal" button.

## WebView bridge (`web/`)
Messages are JSON strings through `postMessage` / `onMessage`. Binary data is base64.

| Direction | Terminal | Editor |
|---|---|---|
| RN → Web | `write{data}`, `clear`, `focus`, `theme{dark}`, `fontSize{px}` | `open{path,content,language,readOnly,line?}`, `setReadOnly{v}`, `diff{original,modified,language}`, `theme{dark}`, `requestSave` |
| Web → RN | `ready{cols,rows}`, `input{data}`, `resize{cols,rows}`, `link{url}` | `ready`, `dirty{v}`, `save{content}`, `cursor{line,col}` |

- `vite-plugin-singlefile` inlines all JS and CSS. `scripts/embed-web.mjs` runs `vite build` and writes `export default "<html…>"` into `src/webviews/generated/*.ts`.
- Use `source={{ html }}` with `originWhitelist={['*']}`.
- Terminal: xterm `FitAddon`, refit on resize/orientation, and use `onData` for input. Mobile keyboards need the hidden-textarea focus trick, so call `term.focus()` on tap.
- Editor: language packs for js/ts/jsx/tsx, json, md, css, html, python, php, go, rust, yaml, sh, and sql (lazy-loaded). Turn on line wrapping by default on phones.

## Notifications
- On host connect: `Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })` → `push.register`.
- On tap: route by `data.kind`: `result` → the chat session, `permission` → the chat session with the PermissionSheet open.
- On Android, create the channels `agent` (default importance) and `approvals` (high importance).

## App config and builds
- `app.config.ts`: name `niCode`, slug `nicode`, scheme `nicode`, `ios.bundleIdentifier`/`android.package` = `com.<you>.nicode`.
- Plugins: expo-camera (permission text), expo-notifications, expo-secure-store, and `expo-build-properties` → Android `usesCleartextTraffic: process.env.APP_VARIANT === 'development'`. This allows `ws://` only for local dev builds.
- `eas.json` profiles:
  - `development`: developmentClient, internal distribution, Android `apk`, env `APP_VARIANT=development`
  - `preview`: internal, Android `apk`
  - `production`

  iOS builds use the EAS cloud and need an Apple Developer account.
- Theme: dark first, follows the system setting. Touch targets ≥ 44 pt. The composer uses `KeyboardAvoidingView`. Use monospace fonts for code and terminal.

## Milestones and acceptance
| # | Build | Acceptance (Android emulator unless noted) |
|---|---|---|
| M1 | Project scaffold, theme, hosts store, RPC client, **Pair with QR/code** (scan, URI, manual), `server.info` screen | Connects to the WSL dev daemon (`ws://10.0.2.2:7878`); killing the daemon shows red and recovers automatically |
| M2 | DO API client, do-token, do-plan, the provisioning machine through `installing`, progress timeline | With a real PAT: the droplet is created, the timeline goes live and reaches `needs_claude_login`; killing the app mid-way resumes; "Destroy" deletes the droplet |
| M3 | **Connect to my server (SSH)**: probe, pair-only, repair, install branches; Claude/GitHub login screens shown only when needed; token rotation for DO; Devices screen | (a) A server with niCode already installed and Claude logged in → paired in seconds with **no login screen**. (b) An existing droplet with Claude logged in as root and no niCode → installs, reuses root's login, no login screen. (c) A fresh server → Claude login appears. Pairing a second device leaves the first connected |
| M4 | Terminal (web build pipeline, TerminalView, ExtraKeysBar, multiple terminals) | `htop`, `vim` and Ctrl-C work; backgrounding and returning replays the screen |
| M5 | Chat with all cards, composer, modes, models, interrupt, PermissionSheet | Ask Claude to add a function → approve the Edit → the diff card shows; deny works; Stop works |
| M6 | Files and editor | Browse, open, edit and save; editing while Claude changes the file → conflict prompt |
| M7 | Changes / git | Stage, commit and push the agent's change; branch switch |
| M8 | Push notifications | With the phone locked: a "finished" and an "approval needed" notification; tapping one deep-links |
| M9 | EAS profiles, icons, splash, settings (forget DO token, bypass toggle), polish | `eas build -p android --profile preview` APK installs on a real phone and the full flow works over https |

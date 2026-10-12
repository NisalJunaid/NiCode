# niCode

A phone-first remote IDE for AI-agent coding. An Expo app provisions a DigitalOcean droplet, runs Claude Code there on the user's subscription, and drives it over WSS. Start with [docs/00-OVERVIEW.md](docs/00-OVERVIEW.md).

## Layout
- `installer/`: bash installer (auto-detecting, idempotent) + `bin/nicode` CLI + cloud-init template. See docs/01.
- `dist/nicode-install.sh`: **generated** single-file bundle. Never edit it; run `bash installer/build.sh` and commit the result.
- `protocol/types.ts`: the wire contract shared by server and app. See docs/05.
- `server/`: Node/TS daemon. Spec: docs/02. Develop in WSL.
- `app/`: Expo React Native app. Spec: docs/04. Develop on Windows.

## Rules
- **Protocol changes** touch `protocol/types.ts` and `docs/05-PROTOCOL.md` in the same change, and bump `PROTOCOL_VERSION` if they break compatibility.
- **Installer steps**:
  - `step_<id>()` runs in a subshell with `set -e`. Return 0 = done, 2 = skipped, anything else = failed.
  - Report details with `step_detail`. Persist decisions with `profile_set`.
  - Never prompt inside a step. Every step must be idempotent and detect existing state.
- **Installer ↔ daemon contract**:
  - The daemon is started as `node /opt/nicode/server` (package.json `main`).
  - Config comes from `$NICODE_CONFIG` (schema in docs/02, written by `tmpl_daemon_config` in `installer/lib/templates.sh`).
  - Status lives in `status.json`, matching `SetupStatus` in types.ts.
- **Security**: never build shell strings from request params (use `execFile`/`spawn` with arrays); guard every path with realpath under `projectsRoot`; never log tokens.
- Shell scripts and `installer/bin/*` must keep **LF** line endings (enforced by `.gitattributes`).
- The repo is `github.com/NisalJunaid/NiCode` (public; servers download `dist/nicode-install.sh` from its raw URL and clone it over HTTPS). Keep the `NICODE_REPO` default in `installer/install.sh` and the app config in sync with it.

## Commands
- Installer: `bash installer/install.sh --dry-run --force` (safe anywhere, including Git Bash), `bash installer/build.sh`, and `shellcheck installer/install.sh installer/lib/*.sh installer/bin/nicode` (in WSL).
- Protocol: `npx -p typescript tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext protocol/types.ts`.
- Server: `cd server && npm run dev | build | test` (WSL).
- App: `cd app && npx expo start --dev-client`, plus `npx expo run:android` after native dependency changes (Windows).

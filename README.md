# niCode

Code with AI agents from your phone. niCode is a mobile alternative to VS Code Remote:
- **Bring your own server or create one:** connect to an existing server with just its SSH details (it reuses your existing Claude login and repos), pair with a QR code, or paste a DigitalOcean token and let the app create a droplet.
- **Claude Code runs on the server**, logged in with your Claude subscription (the login happens inside the app).
- **Native mobile UI:** agent chat with diff cards and approve/deny, files and editor, git changes, and a tmux-backed terminal.
- **Secure by default:** HTTPS through Caddy on an automatic `sslip.io` certificate, a hashed bearer token, key-only SSH, and a firewall.

## Status
| Part | State |
|---|---|
| Server installer (`installer/`, `dist/nicode-install.sh`) | ✅ written; `--dry-run` tested |
| Protocol (`protocol/types.ts`) | ✅ written |
| Daemon (`server/`) | ✅ v0.8.0 (phone keys + signed logins, multiple Claude accounts with usage, checkpoints/undo, history + restore, sites, pm2 apps & tasks, live preview, logs, push alerts); 82 tests passing, v0.1.0 verified on the droplet ([docs/02](docs/02-SERVER-BLUEPRINT.md)) |
| App (`app/`) | ✅ v0.8.0: Claude usage per account (5-hour + weekly), undo per Claude turn, what-changed card, commit history + restore, Share to niCode, Claude account switching, animated NiCode logo, dark/light theme, images in chat, live preview, logs, notification settings, pairing, chat with approvals, new-app starters, files, changes, terminal, websites & domains (nginx + HTTPS), apps & builds (pm2) ([docs/04](docs/04-APP-BLUEPRINT.md)); DO/SSH onboarding not yet |

## Get started
1. Read [docs/00-OVERVIEW.md](docs/00-OVERVIEW.md).
2. Set up Windows and WSL: [docs/03-LOCAL-DEV-SETUP.md](docs/03-LOCAL-DEV-SETUP.md).
3. Try the installer: `bash installer/install.sh --dry-run` ([docs/01](docs/01-INSTALLER.md)).
4. Build the daemon, then the app, by giving Claude Code the kickoff prompts in docs/02 and docs/04.

## Manual server install
```bash
curl -fsSL https://raw.githubusercontent.com/NisalJunaid/NiCode/main/dist/nicode-install.sh -o nicode-install.sh
sudo bash nicode-install.sh
```

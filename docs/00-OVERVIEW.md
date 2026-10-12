# 00 — niCode overview

**niCode** is a phone-first remote IDE for coding with AI agents. One app install creates and configures a DigitalOcean droplet (or uses your own server), logs Claude Code in with **your Claude subscription**, and lets you drive agents, browse and edit files, review and commit changes, and use a terminal, all from your phone.

## Architecture
```
 Phone (Expo app)                                   Droplet (Ubuntu 24.04)
┌──────────────────────────┐   HTTPS / WSS 443   ┌──────────────────────────────────────────────┐
│ Onboarding / provisioning├────────────────────►│ Caddy  (<ip-dashed>.sslip.io, Let's Encrypt) │
│ Chat · Files · Changes   │  Bearer token       │   ├─ /setup/status  → status.json (static)   │
│ Terminal (xterm WebView) │                     │   └─ /ws, /health   → 127.0.0.1:7878         │
│ Editor (CodeMirror WV)   │                     │                                              │
└────────┬─────────────────┘                     │ niCode daemon (Node, user "dev", systemd)    │
         │ DO API (create/poll/destroy)          │   ├─ claude -p --stream-json  (per session)  │
         ▼                                       │   │    └─ MCP "approve" → asks the phone     │
   api.digitalocean.com ── user_data ──────────► │   ├─ node-pty → tmux sessions                │
                          (cloud-init runs        │   ├─ files / ripgrep / git / gh             │
                           nicode-install.sh)     │   └─ Expo push → notifications              │
                                                 │ Claude Code CLI ── subscription OAuth token  │
                                                 └──────────────────────────────────────────────┘
```

## Key decisions and why
| Decision | Why |
|---|---|
| **Claude Code runs on the server**, not the phone | It's a Node CLI that needs a shell, the filesystem, git and processes. The phone is a remote control, the same model as VS Code Remote-SSH (thin client, server-side agent). |
| **Subscription auth through `claude setup-token`** | It produces a long-lived OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) tied to your Pro/Max plan. There's no API billing, and it works headless. The OAuth step itself needs a browser, so the app opens it. |
| **A daemon instead of raw SSH** | Claude's `stream-json` output gives structured events, so the app can render a native chat with diff cards and approve/deny buttons instead of a cramped TUI. Sessions survive the phone sleeping. Push notifications are possible. |
| **Caddy plus sslip.io for HTTPS** | Real TLS with no domain to buy and no extra app on the phone. Only ports 22, 80 and 443 are open, and the daemon listens only on localhost. |
| **The app provisions through the DO API and cloud-init** | It's "one app install": no SSH from the phone needed, and progress is visible through `/setup/status`. |
| **The installer auto-detects** | The same script works on a DigitalOcean droplet, a generic VPS and WSL, needs no questions, is idempotent and resumable, and doubles as `nicode doctor`. |
| **tmux behind every terminal** | Terminals survive app disconnects and daemon restarts. |
| **One protocol file shared by both sides** | `protocol/types.ts` stops the app and the daemon from drifting apart. |

## Three ways to add a server
| Option | You provide | What happens | Logins shown |
|---|---|---|---|
| **Connect to my server** | SSH host, user, key or password | The app probes over SSH. If niCode is installed it adds a device token (`nicode token add`). Otherwise it runs the installer, which reuses the existing Claude user and repos folder, and works alongside an existing nginx | None if Claude is already logged in on the server |
| **Pair with QR / code** | Output of `nicode pair` on the server (one-time code, 10 min) | No SSH; the app registers its hardware public key | None if already logged in |
| **Create on DigitalOcean** | DO API token | The app creates the droplet; cloud-init installs; live progress | Claude (and optionally GitHub) on a fresh droplet |

Every phone or tablet gets its **own token**, so pairing a new device never disconnects the others.

## Provisioning flow (DigitalOcean path)
```
App                         DigitalOcean                 Droplet
 │ validate PAT ─────────────►│
 │ POST /droplets (user_data:  │
 │  token, setupId) ──────────►│── boots ───────────────►│ cloud-init → nicode-install.sh --unattended
 │ poll droplet → IP ─────────►│                         │ detect → system → user → harden
 │ poll https://<ip>.sslip.io/setup/status?sid ───────────►│ edge: Caddy up, cert issued → status visible
 │   (live step timeline)                                │ node → claude → git → daemon → finish
 │ WSS connect (token) ─────────────────────────────────►│ state: needs_claude_login
 │ setup.claudeLogin.start → URL → browser → code ──────►│ claude setup-token → token saved → verified
 │ setup.github.start → device code (optional) ─────────►│ gh auth login → git identity
 │ ready: projects → chat / files / changes / terminal
```

## Security model
- **Who can connect:** only paired phones. There are no reusable passwords:
  - Each phone keeps a private key in its secure hardware (Android Keystore / iOS Secure Enclave). It never leaves the phone, and it's unlocked by fingerprint or face (once per unlock, with a 5-minute grace period).
  - **Pairing** uses a one-time code from `nicode pair` (single use, expires after 10 minutes), so a screenshot of the QR is useless afterwards.
  - **Every connection** signs a fresh single-use challenge from the server, so captured traffic can't be replayed.
  - The browser test console uses **short-lived** tokens only (`nicode token add --expires 1h`). Old permanent tokens are rejected and removed on update.
- **What a connection can do:** effectively anything the server user can do (root, if niCode runs as root), because Claude Code with permissions is remote code execution by design. Revoke a lost phone with `nicode token revoke <name>`; its open connection drops immediately.
- **Mitigations:**
  - TLS only, with the daemon on localhost behind Caddy
  - per-IP backoff, plus fail2ban for SSH
  - key-only SSH, and ufw allowing only 22, 80 and 443
  - automatic security updates
  - no shell interpolation of request parameters, and realpath guards on all file access
  - secrets redacted from logs
  - Claude tool use goes through the phone's approve/deny unless you choose Auto-edit or Bypass
- **Subscription terms:** this is a personal tool on your own server using your own subscription. Don't share access or resell it. Usage limits (5-hour and weekly) apply to long agent runs.

## Risks
| Risk | Mitigation |
|---|---|
| Let's Encrypt rate limits or outages for sslip.io | Verified early (M1 spike). Fallback: `--domain` with your own A record, or `--transport tailscale` |
| The token is visible in droplet metadata (user_data) | Rotated immediately after setup. The answers file is shredded after install |
| Claude CLI flags or stream-json shapes change | Flags are verified against `claude --help` at M4. Events pass through raw and the app renders unknown types gracefully. `nicode update` updates both |
| Scraping the `claude setup-token` PTY output breaks | Manual paste-token fallback in the app, and `nicode login` |
| The React Native SSH library breaks on a new SDK | Only the "use my server" path depends on it. The DO path needs no SSH |

## Repository map
| Path | What | Built by |
|---|---|---|
| `installer/` | Auto-detecting server installer (bash) + `nicode` CLI + cloud-init template | Already written |
| `dist/nicode-install.sh` | Bundled single-file installer (committed; servers download it) | `bash installer/build.sh` |
| `protocol/types.ts` | Wire contract | Already written |
| `server/` | Daemon | Claude Code from [02](02-SERVER-BLUEPRINT.md) |
| `app/` | Expo app | Claude Code from [04](04-APP-BLUEPRINT.md) |
| `docs/` | This documentation | Already written |

## Reading order
1. This file
2. [03-LOCAL-DEV-SETUP](03-LOCAL-DEV-SETUP.md): get Windows and WSL ready
3. [01-INSTALLER](01-INSTALLER.md): try `--dry-run`, then `--stage base` in WSL
4. [05-PROTOCOL](05-PROTOCOL.md): the contract
5. [02-SERVER-BLUEPRINT](02-SERVER-BLUEPRINT.md): build the daemon (in WSL, with Claude Code)
6. [04-APP-BLUEPRINT](04-APP-BLUEPRINT.md): build the app (on Windows, with Claude Code)

## Roadmap after v1
- Prebuilt server tarballs from GitHub Releases (faster installs, no build-essential needed)
- Multiple servers and projects in parallel; agents in separate **git worktrees**
- Voice input in the composer
- Port forwarding / preview URLs for dev servers (`https://<port>-<host>` through Caddy)
- Snapshot and resize the droplet from the app

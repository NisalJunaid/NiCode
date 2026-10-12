# 01 — Server installer

`dist/nicode-install.sh` turns a fresh Ubuntu/Debian machine into a niCode host. **It detects everything itself.** You don't answer questions; you review one screen and press Proceed. The only browser-based steps (the Claude and GitHub logins) happen later in the app.

Normally **the app runs the installer for you**, via cloud-init on new droplets or over SSH on your own server. This page is for running it by hand, debugging it, and maintaining it.

## Quick start (manual)
```bash
# on a fresh Ubuntu 22.04/24.04 server, as root (or with sudo)
curl -fsSL https://raw.githubusercontent.com/NisalJunaid/NiCode/main/dist/nicode-install.sh -o nicode-install.sh
sudo bash nicode-install.sh --dry-run    # see what it detected and what it would do
sudo bash nicode-install.sh              # review screen → Proceed
```
At the end it prints a **QR code**. In the app, choose *Scan pairing QR*, then log in to Claude from the app (or run `nicode login` on the server).

Re-running is safe: finished steps are skipped, and an interrupted run continues where it stopped.

## Existing droplet you already use
This is the common case: a server you've been coding on, maybe as `root`, with Claude Code already logged in and repos in `/root`, `~/code` or `/var/www`.

**Easiest:** in the app, choose **Connect to my server** and enter host, user and SSH key or password. The app installs niCode if needed and pairs. Nothing else is required.

**By hand:**
```bash
ssh root@your-droplet
curl -fsSL https://raw.githubusercontent.com/NisalJunaid/NiCode/main/dist/nicode-install.sh -o nicode-install.sh
sudo bash nicode-install.sh --dry-run     # check: User = the one logged in to Claude, Projects = your repos folder
sudo bash nicode-install.sh               # Proceed → QR at the end → scan in the app (Pair with QR)
```
The installer recognises an **existing server** (a web server, other public services such as game servers, git repos, or an existing Claude setup) and switches to **existing mode**. The plan shows `Mode  EXISTING server`. In that mode it **only adds niCode**:
- no `apt upgrade`, and services are never restarted (needrestart is set to list-only)
- no swap or sysctl changes
- SSH config and fail2ban are untouched; an inactive firewall stays off, and an active ufw only gets 80/443 opened
- your Node is reused if it's ≥ 20; otherwise niCode gets a private Node in `/opt/nicode/node`, and the system Node is never replaced

Force either mode with `--host-mode fresh|existing`.

What it does on an existing server:
- **Reuses your setup.** It runs niCode as the user who is already logged in to Claude, including **root** (`--no-root` opts out), and points niCode at the folder holding your git repos (`--projects-root DIR` to choose another). Your Claude login (`claude` → `/login`) is used as-is, so the app shows **no login step**.
- **Touches nothing that already works.** Installed packages, Node, Claude Code, gh, swap and firewall rules are detected and skipped. Password SSH login is only disabled when key login is confirmed for the user you log in with. If you rely on password SSH, run with `--skip harden`.
- **Works alongside your existing websites.** If **nginx** already serves ports 80 and 443, the installer doesn't add Caddy. Instead it adds one extra nginx site (`/etc/nginx/sites-available/nicode.conf`) for `<ip-dashed>.sslip.io`, and certbot gives it a certificate. Your other sites are untouched. With no web server present it uses Caddy. With Apache or anything else on those ports it stops and suggests `--transport tailscale`.
- **Adds** the `nicode` service and the `nicode` command.

**Adding more phones/tablets later:** run `nicode pair "Tablet"` on the server and scan the QR. Each device has its own token; `nicode token list` and `nicode token revoke <name>` manage them.

## What it detects (`installer/lib/detect.sh` → `/var/lib/nicode/profile.env`)
| Area | How | Used for |
|---|---|---|
| OS, version, CPU | `/etc/os-release`, `uname -m` | Supported check; package sources |
| Platform | DO metadata at `169.254.169.254` (droplet id, region, public IP); `/proc/version` (WSL); container markers; `/run/systemd/system` | Transport choice, which steps apply |
| Public address | DO metadata, otherwise `api.ipify.org` | `<ip-dashed>.sslip.io` hostname for HTTPS |
| Resources | `nproc`, `/proc/meminfo`, `df` | Swap size (none if ≥ 8 GB RAM or swap already exists, otherwise min(RAM, 4 GB)); warnings |
| User | `--user` → `$SUDO_USER` → a user already logged in to Claude → **root, if root is logged in to Claude** (unless `--no-root`) → the first sudo user with SSH keys → a new `dev` | Who runs Claude and the daemon; reusing an existing login avoids logging in again |
| Projects folder | `--projects-root` → existing config → whichever of `~/projects`, `~/code`, `~/src`, `~/repos`, `/var/www`, `/srv`, `~` holds the most git repos → `~/projects` | What the app shows as projects |
| Installed tools | `dpkg -s`, `node -v`, `claude --version`, `gh auth status`, `git config`, `caddy`, `tailscale`, `ufw`, `sshd -T` | Skipping work that's already done |
| Existing logins | `~/.claude/.credentials.json` (normal `/login`) or the env file token; `gh auth status` | Skipping logins in the app |
| Port | Existing config, otherwise the first free port from 7878 | Daemon port on localhost |

The **transport** is chosen automatically:
- `https` when there's a public IP (DigitalOcean or any VPS)
- `local` on WSL, in containers, or with no public IP (development only; plain `ws://`)
- `tailscale` only if you pass `--transport tailscale`

## Steps
Each step is idempotent and skips itself when it's already done or doesn't apply.

| Id | What it does |
|---|---|
| `detect` | Builds the profile; refuses unsupported OSes (override with `--force`) |
| `system` | `apt upgrade`; installs only the missing packages; creates swap; enables automatic security updates |
| `user` | Reuses or creates the dev user; sets up passwordless sudo (`NICODE_SUDO_NOPASSWD=0` to opt out); copies root's SSH keys; enables lingering; creates `~/projects`; adds tmux defaults |
| `harden` | Key-only SSH (**only if** a key login is confirmed to exist); ufw allows 22, 80 and 443; fail2ban. Skipped on WSL and containers |
| `edge` | `https`: installs Caddy (or, if nginx already owns 80/443, adds an nginx site and runs certbot), gets a Let's Encrypt certificate for the sslip.io name, and serves `/setup/status`. `tailscale`: joins the tailnet. `local`: nothing |
| `node` | Node 22 LTS from NodeSource, if missing or older |
| `claude` | Claude Code for the dev user (native installer, falling back to npm). **No login here** |
| `git` | GitHub CLI; git defaults; identity if `--git-name`/`--git-email` are given |
| `daemon` | Fetches the niCode repo to `/opt/nicode`, builds `server/`, writes `~/.config/nicode/config.json` (the token is stored hashed), installs and starts `nicode.service`, checks `/health`. If `server/` doesn't exist in the repo yet, it skips cleanly (state `base_ready`) |
| `finish` | Final state, MOTD line, deletes the one-time answers file, prints the summary and pairing QR |

`--stage base` stops before `daemon`, which is useful while `server/` doesn't exist yet. Run `sudo nicode update` later to add the daemon.

## Options
Run `bash nicode-install.sh --help`. The important ones:

| Flag | Meaning |
|---|---|
| `--dry-run` | Detect and print the plan, then exit. No root needed, nothing changes |
| `--unattended` | No review screen and no prompts (used by the app and cloud-init) |
| `--stage base\|full` | Tools only, or tools plus the daemon (default `full`) |
| `--token`, `--setup-id` | Supplied by the app so it can follow progress and connect. Without them, the installer generates its own |
| `--transport`, `--domain` | Override the transport choice, or use your own domain instead of sslip.io |
| `--projects-root DIR`, `--no-root`, `--user NAME` | Override the detected projects folder and user |
| `--device-name NAME` | Label for the device token passed with `--token` |
| `--source-dir DIR` | Build the daemon from a local checkout instead of cloning (WSL development) |
| `--config FILE` | Source `NICODE_*` variables from a file (cloud-init answers) |
| `--only`, `--skip`, `--redo` | Step selection, for example `--redo daemon` |

Every flag also has an environment-variable form: `NICODE_TOKEN`, `NICODE_STAGE`, `NICODE_TRANSPORT`, `NICODE_USER`, `NICODE_NO_ROOT`, `NICODE_PROJECTS_ROOT`, `NICODE_DEVICE_NAME`, `NICODE_PORT`, `NICODE_DOMAIN`, `NICODE_REPO`, `NICODE_REF`, `NICODE_SOURCE_DIR`, `NICODE_TS_AUTHKEY`, `NICODE_GIT_NAME`, `NICODE_GIT_EMAIL`, `NICODE_CLAUDE_VERSION`, `NICODE_SUDO_NOPASSWD`. Precedence: saved settings < `--config` < environment < flags.

## Files it creates
| Path | What |
|---|---|
| `/etc/nicode/install.env` | Persisted non-secret settings (repo, ref, transport, user, port, setup id) |
| `/var/lib/nicode/profile.env` | Last detection result |
| `/var/lib/nicode/done/<step>` | Completion markers (delete one, or use `--redo`, to re-run that step) |
| `/var/lib/nicode/public/status.json` | Live status (served at `/setup/status?sid=…`) |
| `/var/log/nicode-install.log` | Full command log |
| `/usr/local/bin/nicode`, `/usr/local/lib/nicode/nicode-install.sh` | Management CLI and a stable copy of the installer |
| `/etc/caddy/nicode.caddy` | Caddy site (imported from `/etc/caddy/Caddyfile`) |
| `/etc/systemd/system/nicode.service` | The daemon unit (`User=<dev>`, `KillMode=process` so tmux survives restarts) |
| `/opt/nicode` | The niCode checkout the daemon is built from |
| `~<user>/.config/nicode/{config.json,env}` | Daemon config (one hashed token per paired device) and env (`CLAUDE_CODE_OAUTH_TOKEN`, only if logged in through the app), both mode 600 |
| `/etc/ssh/sshd_config.d/10-nicode.conf`, `/etc/sudoers.d/90-nicode-<user>` | Hardening and sudo |

## The `nicode` command
```
nicode status [--json]       # daemon, endpoint, Claude/GitHub login, paired devices
nicode pair [name]           # pair another phone: new device token + QR (others keep working)
nicode token add <name> [--json] | list | revoke <id|name> | rotate
nicode login                 # terminal Claude login (skipped if already logged in)
nicode doctor                # re-detect and show what the installer would change
nicode logs -f               # daemon logs
nicode restart
nicode update                # newest installer + Claude Code + rebuild daemon
nicode uninstall             # remove niCode (keeps projects, user, Claude)
```
`status --json` and `token add --json` are what the app runs over SSH when you use **Connect to my server**.

## How the app uses it
1. When creating a droplet, the app sends [cloud-init.yaml.tmpl](../installer/cloud-init.yaml.tmpl) as `user_data`, with a token and setup id it generated.
2. cloud-init downloads the bundle and runs `--unattended --config /root/nicode-answers.env`.
3. Caddy comes up during the `edge` step. The app polls `https://<ip-dashed>.sslip.io/setup/status?sid=<id>` and shows each step live.
4. When the state reaches `needs_claude_login`, the app connects over WSS and runs the Claude login, then the GitHub login, then **rotates the token**, because the original one was in user_data, which stays readable through the droplet metadata service.

## Maintaining the installer
- Edit files under `installer/`, then **rebuild the bundle**: `bash installer/build.sh`. This writes `dist/nicode-install.sh`, which must be committed because servers download that exact file.
- Step contract: `step_<id>()` runs in a subshell with `set -e`.
  - Return `0` = done, `2` = skipped/not applicable, anything else = failed.
  - Report a short detail with `step_detail "…"`.
  - Persist decisions for later steps with `profile_set KEY value`.
  - **Never prompt** inside a step.
- Templates are heredoc functions in `lib/templates.sh` (not separate files), so the bundle stays a single file.
- Before committing, test with `bash installer/install.sh --dry-run --force` (works even in Git Bash on Windows) and run `shellcheck installer/install.sh installer/lib/*.sh installer/bin/nicode` in WSL.
- Real tests: a throwaway droplet (`--stage base` first), then run it again to confirm every step reports "already done", kill it mid-step and check `--resume`, and finally `--stage full` once `server/` exists.
- The repo is public at `github.com/NisalJunaid/NiCode`. If it ever moves, update the `NICODE_REPO` default in `installer/install.sh` and the app config, then rebuild.

## Troubleshooting
| Symptom | Check |
|---|---|
| The app is stuck at "Waiting for the server…" | The droplet console (DO web UI): `tail -f /var/log/nicode-cloud-init.log /var/log/nicode-install.log` |
| Certificate pending | `journalctl -u caddy`. Port 80/443 must be reachable. Let's Encrypt rate limits on sslip.io are rare; as a fallback use `--domain your.domain` with an A record |
| `daemon did not answer /health` | `journalctl -u nicode -n 100`. Then `cd /opt/nicode/server && npm run build` as the dev user |
| Locked out of SSH | Hardening only applies when keys exist, but you can always use the DO web console. Remove `/etc/ssh/sshd_config.d/10-nicode.conf` there |
| Claude login fails in the app | Run `nicode login` over SSH or the DO console, or paste a token from `claude setup-token` run on any computer |

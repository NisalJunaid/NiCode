# 03 — Local development setup (Windows + WSL2)

Everything is developed on your Windows PC. The droplet is only a deployment target.

| Part | Where it runs while developing |
|---|---|
| `app/` (Expo) | **Windows**, natively: Android emulator or your phone over USB |
| `server/` (daemon) and `installer/` | **WSL2 Ubuntu 24.04** on the same PC (real Linux: bash, tmux, node-pty, systemd) |
| Real provisioning tests | Throwaway DigitalOcean droplets created by the app (or by hand), destroyed afterwards |

The repo lives at `C:\laragon\www\niCode`. WSL sees it as `/mnt/c/laragon/www/niCode`, so there's one checkout and both sides use it.

## 1. Windows toolchain (PowerShell)
```powershell
winget install -e --id OpenJS.NodeJS.LTS          # Node 22 LTS
winget install -e --id Git.Git
winget install -e --id Microsoft.OpenJDK.17
winget install -e --id Google.AndroidStudio
```
Open **Android Studio** once and use **More Actions → SDK Manager** to install:
- Android SDK Platform 35 (or whatever the current Expo SDK targets)
- Android SDK Platform-Tools, Build-Tools, and Command-line Tools

Then create an emulator with **Device Manager** (Pixel, API 35, x86_64 image).

```powershell
[Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
[Environment]::SetEnvironmentVariable('JAVA_HOME', (Get-ChildItem 'C:\Program Files\Microsoft\jdk-17*' | Select-Object -First 1).FullName, 'User')
$p = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$p;$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:LOCALAPPDATA\Android\Sdk\emulator", 'User')
# restart the terminal / VS Code, then check:
node -v; java -version; adb version
```
Then install the Expo tooling (an Expo account is free, and EAS needs one):
```powershell
npm i -g eas-cli
eas login
```
**Physical Android phone:** turn on Developer options → USB debugging, plug it in, and run `adb devices`.
**iPhone:** you can't build iOS on Windows. Use `eas build -p ios --profile development` in the cloud (requires an Apple Developer account, $99/yr), then install it through the EAS link.

## 2. WSL2 for the server (PowerShell as admin)
```powershell
wsl --install -d Ubuntu-24.04
```
Then create `%UserProfile%\.wslconfig`. Mirrored networking means a port opened in WSL is also `localhost` on Windows, which the emulator and USB phone can reach:
```ini
[wsl2]
networkingMode=mirrored
memory=8GB
```
Inside Ubuntu, enable systemd so the installer can install the daemon as a service:
```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```
Run `wsl --shutdown` in PowerShell and reopen Ubuntu.

Install **VS Code's "WSL" extension**. From Ubuntu, `cd /mnt/c/laragon/www/niCode && code .` opens the repo with a Linux backend, and the Claude Code extension and CLI then run inside WSL.

## 3. Make WSL a local niCode dev host
```bash
cd /mnt/c/laragon/www/niCode
sudo bash installer/install.sh --dry-run          # see detection: platform=wsl, transport=local
sudo bash installer/install.sh --stage base       # tools, Node 22, Claude Code, gh (reuses your WSL user)
claude                                            # then /login with your subscription, for your own CLI use
```
Before `server/` exists, use `--stage base`. Then build the daemon with Claude Code using the kickoff prompt in [02-SERVER-BLUEPRINT](02-SERVER-BLUEPRINT.md). During development, run it directly:
```bash
cd /mnt/c/laragon/www/niCode/server
npm install
# dev config (token "dev" → its sha256), local transport:
mkdir -p ~/.config/nicode && cat > ~/.config/nicode/dev.json <<EOF
{"version":1,"bindHost":"0.0.0.0","port":7878,
 "tokenSha256":"$(printf dev | sha256sum | cut -d' ' -f1)",
 "transport":"local","publicHost":"localhost","user":"$USER",
 "projectsRoot":"$HOME/projects","dataDir":"$HOME/.nicode",
 "envFile":"$HOME/.config/nicode/env","statusFile":"$HOME/.nicode/status.json",
 "claudeBin":"$(command -v claude)","appDir":"/mnt/c/laragon/www/niCode"}
EOF
NICODE_CONFIG=~/.config/nicode/dev.json CHOKIDAR_USEPOLLING=1 npm run dev
```
When the daemon is ready, test the real install path: `sudo bash installer/install.sh --source-dir /mnt/c/laragon/www/niCode`. It builds from your checkout and installs `nicode.service` in WSL.

> If `npm install` or watching files on `/mnt/c` is too slow, clone the repo inside WSL instead (`~/niCode`, using the same GitHub remote) for server work, and sync with git.

## 4. Connect the app to the local daemon
| Device | URL in the app ("Add host manually") |
|---|---|
| Android emulator | `ws://10.0.2.2:7878`, token `dev` |
| Phone over USB | `adb reverse tcp:7878 tcp:7878`, then `ws://localhost:7878` |
| Phone over Wi-Fi | `ws://<PC LAN IP>:7878`. Allow it through Windows Firewall: `New-NetFirewallRule -DisplayName niCode-dev -Direction Inbound -LocalPort 7878 -Protocol TCP -Action Allow -Profile Private` |

Plain `ws://` only works in the **development** build variant (cleartext is enabled only there; see 04).

## 5. Build the app
In PowerShell or VS Code on Windows, at the repo root, start Claude Code with the kickoff prompt from [04-APP-BLUEPRINT](04-APP-BLUEPRINT.md). Day to day:
```powershell
cd C:\laragon\www\niCode\app
npx expo run:android      # first time and after native dependency changes (builds the dev client)
npx expo start --dev-client   # day-to-day: Metro; press "a" for the emulator
```

## 6. End-to-end against real DigitalOcean
1. The repo is public at `github.com/NisalJunaid/NiCode`. After any change under `installer/`, run `bash installer/build.sh` and commit `dist/` before testing on a droplet.
2. In the app, choose **Create a server on DigitalOcean**, paste a PAT, and confirm the plan. Watch the timeline, log in to Claude, and do a chat round trip.
3. Destroy the droplet from the app's **Server** screen. Billing is per hour, so a test costs a few cents.

## Stopgap while niCode is being built
You can already code from your phone today: on any server with Claude Code logged in, run `claude remote-control` (check `claude --help` for the exact command in your version). Then open the session from the Claude mobile app or claude.ai. For a raw terminal, use Termius with `tmux attach`.

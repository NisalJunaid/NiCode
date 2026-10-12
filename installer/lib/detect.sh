# shellcheck shell=bash
# Host detection. Read-only: inspects the machine and writes NI_* decisions to the profile file.
# Every later step reads its decisions from the profile instead of asking the user.

NI_REQUIRED_PKGS=(git tmux ripgrep fd-find jq build-essential python3 curl unzip ca-certificates gnupg qrencode ufw fail2ban unattended-upgrades openssl whiptail)
NI_DO_META="http://169.254.169.254/metadata/v1"

_meta() { curl -fsS --max-time 2 "$NI_DO_META/$1" 2>/dev/null || true; }

_detect_os() {
  NI_OS_ID=unknown; NI_OS_VERSION=unknown; NI_OS_CODENAME=unknown
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    NI_OS_ID="${ID:-unknown}"; NI_OS_VERSION="${VERSION_ID:-unknown}"; NI_OS_CODENAME="${VERSION_CODENAME:-unknown}"
  fi
  NI_OS_SUPPORTED=0
  case "$NI_OS_ID:$NI_OS_VERSION" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:24.10|ubuntu:25.04|debian:12) NI_OS_SUPPORTED=1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) NI_ARCH=amd64 ;;
    aarch64|arm64) NI_ARCH=arm64 ;;
    *) NI_ARCH="$(uname -m)" ;;
  esac
}

_detect_platform() {
  NI_PLATFORM=vm; NI_DROPLET_ID=""; NI_REGION=""; NI_PUBLIC_IP=""
  NI_HOSTNAME="$(hostname 2>/dev/null || echo host)"
  if grep -qi microsoft /proc/version 2>/dev/null; then
    NI_PLATFORM=wsl
  elif [[ -f /.dockerenv ]] || grep -qaE 'docker|lxc|containerd' /proc/1/cgroup 2>/dev/null; then
    NI_PLATFORM=container
  else
    NI_DROPLET_ID="$(_meta id)"
    if [[ "$NI_DROPLET_ID" =~ ^[0-9]+$ ]]; then
      NI_PLATFORM=digitalocean
      NI_REGION="$(_meta region)"
      NI_PUBLIC_IP="$(_meta interfaces/public/0/ipv4/address)"
      NI_HOSTNAME="$(_meta hostname)"
    else
      NI_DROPLET_ID=""
    fi
  fi
  if [[ -z "$NI_PUBLIC_IP" && "$NI_PLATFORM" == vm ]]; then
    NI_PUBLIC_IP="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  fi
  NI_LAN_IP="$( { ip -4 route get 1.1.1.1 2>/dev/null || true; } | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  NI_HAS_SYSTEMD=0
  [[ -d /run/systemd/system ]] && NI_HAS_SYSTEMD=1
  return 0
}

_detect_resources() {
  NI_CPUS="$(nproc 2>/dev/null || echo 1)"
  NI_RAM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  NI_SWAP_MB="$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  NI_DISK_FREE_GB="$( { df -Pk / 2>/dev/null || true; } | awk 'NR==2 {printf "%d", $4/1024/1024}')"
  # Swap: none if already present or RAM >= 8 GB; else min(RAM, 4 GB), at least 1 GB.
  NI_SWAP_PLAN_MB=0
  if (( NI_SWAP_MB == 0 && NI_RAM_MB < 8000 )) && [[ "$NI_PLATFORM" != wsl && "$NI_PLATFORM" != container ]]; then
    NI_SWAP_PLAN_MB=$(( NI_RAM_MB < 1024 ? 1024 : (NI_RAM_MB > 4096 ? 4096 : NI_RAM_MB) ))
  fi
}

_detect_transport() {
  if [[ -n "${NICODE_TRANSPORT:-}" ]]; then
    :
  elif [[ "$NI_PLATFORM" == wsl || "$NI_PLATFORM" == container ]]; then
    NICODE_TRANSPORT=local
  elif [[ -n "$NI_PUBLIC_IP" ]]; then
    NICODE_TRANSPORT=https
  else
    NICODE_TRANSPORT=local
  fi
  NI_PUBLIC_HOST=""
  case "$NICODE_TRANSPORT" in
    https)
      if [[ -n "${NICODE_DOMAIN:-}" ]]; then NI_PUBLIC_HOST="$NICODE_DOMAIN"
      elif [[ -n "$NI_PUBLIC_IP" ]]; then NI_PUBLIC_HOST="${NI_PUBLIC_IP//./-}.sslip.io"
      fi ;;
    local) NI_PUBLIC_HOST="${NI_LAN_IP:-127.0.0.1}" ;;
    tailscale) NI_PUBLIC_HOST="$(tailscale ip -4 2>/dev/null | head -n1 || true)" ;;
  esac
}

_user_has_keys() { [[ -s "$(getent passwd "$1" 2>/dev/null | cut -d: -f6)/.ssh/authorized_keys" ]]; }

# A user counts as "Claude logged in" with either an interactive /login (credentials file)
# or a niCode env token (setup-token). Works for any home dir, including /root.
_home_claude_authed() {
  [[ -s "$1/.claude/.credentials.json" ]] || grep -qs '^CLAUDE_CODE_OAUTH_TOKEN=.' "$1/.config/nicode/env"
}

# Existing servers: reuse whoever is already set up, so nothing has to be logged in again.
# Order: --user > invoking sudo user > a regular user already logged in to Claude
#        > root, if root is the one logged in to Claude (common on hand-made droplets; --no-root opts out)
#        > first sudo user with SSH keys > new "dev".
_detect_user() {
  NI_USER=""; NI_USER_SOURCE=""
  local u home
  if [[ -n "${NICODE_USER:-}" ]]; then
    NI_USER="$NICODE_USER"; NI_USER_SOURCE="configured"
  elif [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]]; then
    NI_USER="$SUDO_USER"; NI_USER_SOURCE="invoking sudo user"
  else
    while IFS=: read -r u _ uid _ _ home _; do
      if (( uid >= 1000 && uid < 60000 )) && _home_claude_authed "$home"; then
        NI_USER="$u"; NI_USER_SOURCE="already logged in to Claude"; break
      fi
    done < <(getent passwd 2>/dev/null || true)
    if [[ -z "$NI_USER" && "${NICODE_NO_ROOT:-}" != 1 ]] && _home_claude_authed /root; then
      NI_USER=root; NI_USER_SOURCE="root is already logged in to Claude"
    fi
    if [[ -z "$NI_USER" ]]; then
      for u in $(getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' ' '); do
        if (( $(id -u "$u" 2>/dev/null || echo 0) >= 1000 )) && _user_has_keys "$u"; then
          NI_USER="$u"; NI_USER_SOURCE="existing sudo user with SSH keys"; break
        fi
      done
    fi
  fi
  [[ -z "$NI_USER" ]] && { NI_USER=dev; NI_USER_SOURCE="new"; }
  NI_USER_EXISTS=0; NI_USER_HOME="/home/$NI_USER"; NI_USER_HAS_KEYS=0
  if id "$NI_USER" >/dev/null 2>&1; then
    NI_USER_EXISTS=1
    NI_USER_HOME="$(getent passwd "$NI_USER" | cut -d: -f6)"
    _user_has_keys "$NI_USER" && NI_USER_HAS_KEYS=1
  fi
  NI_ROOT_HAS_KEYS=0
  [[ -s /root/.ssh/authorized_keys ]] && NI_ROOT_HAS_KEYS=1
  return 0
}

# Where the code lives. --projects-root > existing niCode config > the candidate folder
# holding the most git repos (one level deep) > ~/projects.
_detect_projects_root() {
  local cfg="$NI_USER_HOME/.config/nicode/config.json" d best="" best_n=0 n
  if [[ -n "${NICODE_PROJECTS_ROOT:-}" ]]; then NI_PROJECTS_ROOT="$NICODE_PROJECTS_ROOT"; return 0; fi
  if [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1; then
    NI_PROJECTS_ROOT="$(jq -r '.projectsRoot // empty' "$cfg" 2>/dev/null)"
    [[ -n "$NI_PROJECTS_ROOT" ]] && return 0
  fi
  for d in "$NI_USER_HOME/projects" "$NI_USER_HOME/code" "$NI_USER_HOME/src" "$NI_USER_HOME/repos" /var/www /srv "$NI_USER_HOME"; do
    [[ -d "$d" ]] || continue
    n="$(find "$d" -mindepth 2 -maxdepth 2 -name .git 2>/dev/null | wc -l)"
    if (( n > best_n )); then best="$d"; best_n=$n; fi
  done
  NI_PROJECTS_ROOT="${best:-$NI_USER_HOME/projects}"
  NI_PROJECTS_FOUND="$best_n"
  return 0
}

_detect_packages() {
  NI_MISSING_PKGS=""
  local p
  for p in "${NI_REQUIRED_PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || NI_MISSING_PKGS+="$p "
  done
  NI_MISSING_PKGS="${NI_MISSING_PKGS% }"
}

_user_cmd() {
  # Run a probe as the target user if they exist; prints stdout, never fails.
  (( NI_USER_EXISTS )) || return 0
  if [[ "$(id -un)" == "$NI_USER" ]]; then bash -lc "$1" 2>/dev/null || true
  else sudo -u "$NI_USER" -H bash -lc "$1" 2>/dev/null || true; fi
}

_detect_tools() {
  NI_NODE_VERSION="$( { node -v 2>/dev/null || true; } | tr -d v)"
  NI_NODE_OK=0
  [[ -n "$NI_NODE_VERSION" ]] && (( ${NI_NODE_VERSION%%.*} >= 22 )) && NI_NODE_OK=1

  NI_CLAUDE_BIN="$(_user_cmd 'command -v claude')"
  NI_CLAUDE_VERSION=""
  [[ -n "$NI_CLAUDE_BIN" ]] && NI_CLAUDE_VERSION="$(_user_cmd 'claude --version' | head -n1)"
  NI_CLAUDE_AUTHED=0
  if _home_claude_authed "$NI_USER_HOME"; then NI_CLAUDE_AUTHED=1; fi

  NI_GH_INSTALLED=0; NI_GH_AUTHED=0
  command -v gh >/dev/null 2>&1 && NI_GH_INSTALLED=1
  (( NI_GH_INSTALLED )) && [[ -n "$(_user_cmd 'gh auth status >/dev/null 2>&1 && echo y')" ]] && NI_GH_AUTHED=1
  NI_GIT_NAME="$(_user_cmd 'git config --global user.name')"
  NI_GIT_EMAIL="$(_user_cmd 'git config --global user.email')"

  NI_CADDY_INSTALLED=0; command -v caddy >/dev/null 2>&1 && NI_CADDY_INSTALLED=1
  NI_TAILSCALE_UP=0
  command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1 && NI_TAILSCALE_UP=1
  NI_UFW_ACTIVE=0
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active" && NI_UFW_ACTIVE=1
  NI_SSHD_PASSWORD_AUTH="$( { sshd -T 2>/dev/null || true; } | awk '/^passwordauthentication/ {print $2}')"
  NI_DAEMON_INSTALLED=0
  [[ -f /etc/systemd/system/nicode.service ]] && NI_DAEMON_INSTALLED=1
  return 0
}

_port_free() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

# Which web server (if any) already owns 80/443 decides how HTTPS is set up:
#   none/caddy -> Caddy (default)   nginx -> add a niCode site to nginx + certbot   other -> can't share
_detect_web_server() {
  local owners
  owners="$( { ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true; } \
    | { grep -o 'users:(("[^"]*' || true; } | cut -d'"' -f2 | sort -u | tr '\n' ' ')"
  NI_WEB_SERVER=none
  case "$owners" in
    "") ;;
    *caddy*)          NI_WEB_SERVER=caddy ;;
    *nginx*)          NI_WEB_SERVER=nginx ;;
    *apache*|*httpd*) NI_WEB_SERVER=apache ;;
    *)                NI_WEB_SERVER="other:${owners% }" ;;
  esac
  NI_EDGE=caddy
  case "$NI_WEB_SERVER" in
    nginx) NI_EDGE=nginx ;;
    apache|other:*) NI_EDGE=conflict ;;
  esac
  return 0
}

_detect_port() {
  local cfg="$NI_USER_HOME/.config/nicode/config.json" p
  if [[ -n "${NICODE_PORT:-}" ]]; then NI_PORT="$NICODE_PORT"; return; fi
  # Keep the port of an existing install.
  if [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1; then
    NI_PORT="$(jq -r '.port // empty' "$cfg" 2>/dev/null)"
    [[ -n "$NI_PORT" ]] && return
  fi
  for p in $(seq 7878 7899); do
    if _port_free "$p"; then NI_PORT="$p"; return; fi
  done
  NI_PORT=7878
}

NI_PROFILE_VARS=(
  NI_OS_ID NI_OS_VERSION NI_OS_CODENAME NI_OS_SUPPORTED NI_ARCH
  NI_PLATFORM NI_DROPLET_ID NI_REGION NI_PUBLIC_IP NI_LAN_IP NI_HOSTNAME NI_HAS_SYSTEMD
  NI_CPUS NI_RAM_MB NI_SWAP_MB NI_DISK_FREE_GB NI_SWAP_PLAN_MB
  NICODE_TRANSPORT NI_PUBLIC_HOST
  NI_USER NI_USER_SOURCE NI_USER_EXISTS NI_USER_HOME NI_USER_HAS_KEYS NI_ROOT_HAS_KEYS
  NI_PROJECTS_ROOT NI_PROJECTS_FOUND
  NI_MISSING_PKGS NI_NODE_VERSION NI_NODE_OK
  NI_CLAUDE_BIN NI_CLAUDE_VERSION NI_CLAUDE_AUTHED
  NI_GH_INSTALLED NI_GH_AUTHED NI_GIT_NAME NI_GIT_EMAIL
  NI_CADDY_INSTALLED NI_TAILSCALE_UP NI_UFW_ACTIVE NI_SSHD_PASSWORD_AUTH NI_DAEMON_INSTALLED
  NI_WEB_SERVER NI_EDGE
  NI_PORT
)

detect_all() {
  _detect_os
  _detect_platform
  _detect_resources
  _detect_transport
  _detect_user
  _detect_projects_root
  _detect_packages
  _detect_tools
  _detect_port
  _detect_web_server
  local v
  {
    echo "# niCode host profile — generated $(date -u +%FT%TZ) by detect.sh"
    for v in "${NI_PROFILE_VARS[@]}"; do printf '%s=%q\n' "$v" "${!v:-}"; done
  } >"$NI_PROFILE_FILE"
}

# Human-readable "found / will do" text for the review screen and `nicode doctor`.
detect_plan_text() {
  local yes="✔" todo="➜" na="–" s
  printf 'FOUND\n'
  printf '  Host       %s (%s), %s %s, %s\n' "$NI_HOSTNAME" "$NI_PLATFORM${NI_REGION:+ $NI_REGION}" "$NI_OS_ID" "$NI_OS_VERSION" "$NI_ARCH"
  printf '  Resources  %s vCPU, %s MB RAM, %s MB swap, %s GB free disk\n' "$NI_CPUS" "$NI_RAM_MB" "$NI_SWAP_MB" "$NI_DISK_FREE_GB"
  printf '  Address    %s → %s (%s)\n' "${NI_PUBLIC_IP:-${NI_LAN_IP:-?}}" "${NI_PUBLIC_HOST:-?}" "$NICODE_TRANSPORT"
  printf '  User       %s (%s)\n' "$NI_USER" "$NI_USER_SOURCE"
  printf '  Projects   %s%s\n' "$NI_PROJECTS_ROOT" "$( (( ${NI_PROJECTS_FOUND:-0} )) && echo " (${NI_PROJECTS_FOUND} git repos found)" || true)"
  printf '  Node       %s\n' "${NI_NODE_VERSION:-not installed}"
  printf '  Claude     %s%s\n' "${NI_CLAUDE_VERSION:-not installed}" "$( (( NI_CLAUDE_AUTHED )) && echo ', logged in' || true)"
  printf '  GitHub CLI %s\n' "$( (( NI_GH_AUTHED )) && echo 'logged in' || { (( NI_GH_INSTALLED )) && echo 'installed' || echo 'not installed'; })"
  printf '\nPLAN  (stage: %s)\n' "$NICODE_STAGE"
  for s in $(steps_selected); do
    [[ "$s" == detect ]] && continue
    case "$s" in
      system)  [[ -z "$NI_MISSING_PKGS" && "$NI_SWAP_PLAN_MB" == 0 ]] && printf '  %s %-26s nothing missing\n' "$yes" "${NI_STEP_TITLE[$s]}" \
                 || printf '  %s %-26s install: %s%s\n' "$todo" "${NI_STEP_TITLE[$s]}" "${NI_MISSING_PKGS:-–}" "$( (( NI_SWAP_PLAN_MB )) && echo "; ${NI_SWAP_PLAN_MB} MB swap" || true)" ;;
      user)    (( NI_USER_EXISTS )) && printf '  %s %-26s reuse %s\n' "$yes" "${NI_STEP_TITLE[$s]}" "$NI_USER" \
                 || printf '  %s %-26s create %s%s\n' "$todo" "${NI_STEP_TITLE[$s]}" "$NI_USER" "$( (( NI_ROOT_HAS_KEYS )) && echo ' (copy root SSH keys)' || true)" ;;
      harden)  [[ "$NI_PLATFORM" == wsl || "$NI_PLATFORM" == container ]] && printf '  %s %-26s not applicable (%s)\n' "$na" "${NI_STEP_TITLE[$s]}" "$NI_PLATFORM" \
                 || printf '  %s %-26s key-only SSH, ufw 22/80/443, fail2ban\n' "$todo" "${NI_STEP_TITLE[$s]}" ;;
      edge)    case "$NICODE_TRANSPORT" in
                 https) case "$NI_EDGE" in
                          nginx)    printf '  %s %-26s add a site to your existing nginx + certbot for %s\n' "$todo" "${NI_STEP_TITLE[$s]}" "$NI_PUBLIC_HOST" ;;
                          conflict) printf '  ✗ %-26s ports 80/443 are used by %s: rerun with --transport tailscale (docs/01)\n' "${NI_STEP_TITLE[$s]}" "${NI_WEB_SERVER#other:}" ;;
                          *)        printf '  %s %-26s Caddy + Let'"'"'s Encrypt for %s\n' "$todo" "${NI_STEP_TITLE[$s]}" "$NI_PUBLIC_HOST" ;;
                        esac ;;
                 tailscale) printf '  %s %-26s Tailscale (no public port)\n' "$todo" "${NI_STEP_TITLE[$s]}" ;;
                 local) printf '  %s %-26s local dev: plain ws:// on %s\n' "$na" "${NI_STEP_TITLE[$s]}" "$NI_PUBLIC_HOST" ;;
               esac ;;
      node)    (( NI_NODE_OK )) && printf '  %s %-26s %s already OK\n' "$yes" "${NI_STEP_TITLE[$s]}" "$NI_NODE_VERSION" \
                 || printf '  %s %-26s install Node 22 LTS\n' "$todo" "${NI_STEP_TITLE[$s]}" ;;
      claude)  [[ -n "$NI_CLAUDE_BIN" ]] && printf '  %s %-26s installed%s\n' "$yes" "${NI_STEP_TITLE[$s]}" "$( (( NI_CLAUDE_AUTHED )) || echo ' — login from the app afterwards')" \
                 || printf '  %s %-26s install for %s (login from the app afterwards)\n' "$todo" "${NI_STEP_TITLE[$s]}" "$NI_USER" ;;
      git)     (( NI_GH_INSTALLED )) && printf '  %s %-26s gh present\n' "$yes" "${NI_STEP_TITLE[$s]}" \
                 || printf '  %s %-26s install GitHub CLI, git defaults\n' "$todo" "${NI_STEP_TITLE[$s]}" ;;
      daemon)  printf '  %s %-26s build & run on 127.0.0.1:%s\n' "$todo" "${NI_STEP_TITLE[$s]}" "$NI_PORT" ;;
      finish)  printf '  %s %-26s summary%s\n' "$todo" "${NI_STEP_TITLE[$s]}" "$( [[ "$NICODE_STAGE" == full ]] && echo ' + pairing QR' || true)" ;;
    esac
  done
  if (( NI_RAM_MB > 0 && NI_RAM_MB < 1900 )); then printf '\n  ⚠ Less than 2 GB RAM: Claude Code + builds may be slow.\n'; fi
  if (( NI_DISK_FREE_GB > 0 && NI_DISK_FREE_GB < 10 )); then printf '  ⚠ Less than 10 GB free disk.\n'; fi
  if [[ "$NI_USER" == root ]]; then printf '
  ⚠ Runs as root to reuse your existing Claude login and files. Use --no-root for a separate "dev" user.
'; fi
  if [[ "$NICODE_TRANSPORT" == local ]]; then printf '\n  ℹ Local transport: no TLS. Use only on a trusted LAN / for development.\n'; fi
  return 0
}

#!/usr/bin/env bash
# niCode installer — bundled by installer/build.sh. Do not edit; edit installer/ and rebuild.
NICODE_BUNDLED=1

# ───── lib/00-detect.sh ─────
# Step 0 — build the host profile (read-only).

step_detect() {
  detect_all
  profile_reload
  if (( ! NI_OS_SUPPORTED )); then
    step_detail "unsupported OS: $NI_OS_ID $NI_OS_VERSION (need Ubuntu 22.04+/Debian 12)"
    [[ -n "${NICODE_FORCE:-}" ]] || return 1
  fi
  if [[ "$NI_ARCH" != amd64 && "$NI_ARCH" != arm64 ]]; then
    step_detail "unsupported CPU architecture: $NI_ARCH"
    return 1
  fi
  if [[ "${NICODE_STAGE}" == full && "$NI_HAS_SYSTEMD" != 1 ]]; then
    log_warn "systemd not running: the daemon will not be installed as a service."
  fi
  step_detail "$NI_PLATFORM, $NI_OS_ID $NI_OS_VERSION $NI_ARCH, ${NI_RAM_MB} MB RAM"
}

# ───── lib/01-system.sh ─────
# Step 1 — OS packages, swap, automatic security updates.
# On an "existing" host (see _detect_host_mode) only missing packages are installed:
# no full upgrade, no swap/sysctl changes, no auto-update policy changes.

# Waits up to 10 min for cloud-init / unattended-upgrades to release the dpkg lock.
NI_APT=(apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

step_system() {
  export DEBIAN_FRONTEND=noninteractive
  # Ubuntu 22.04's needrestart otherwise asks which services to restart (hangs unattended runs)
  # or restarts them itself. List only — never restart someone's services.
  export NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
  local done_parts=()

  # An earlier interrupted apt/dpkg run leaves packages half-configured; apt then refuses to
  # install anything. Finishing it can restart services, so on an existing server we stop and
  # let the owner run it; on a fresh host it's safe to finish automatically.
  if [[ -n "$(dpkg --audit 2>/dev/null)" ]] || compgen -G '/var/lib/dpkg/updates/[0-9]*' >/dev/null; then
    if [[ "$NI_HOST_MODE" == existing ]]; then
      step_detail "dpkg has an unfinished earlier run. Fix it first: sudo NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive dpkg --configure -a  (then re-run the installer)"
      return 1
    fi
    run_logged dpkg --configure -a
  fi

  run_logged "${NI_APT[@]}" update

  if [[ "$NI_HOST_MODE" == fresh ]]; then
    run_logged "${NI_APT[@]}" upgrade
    done_parts+=("upgraded")
  fi

  if [[ -n "$NI_MISSING_PKGS" ]]; then
    # shellcheck disable=SC2086  # intentional word splitting of the package list
    run_logged "${NI_APT[@]}" install --no-install-recommends $NI_MISSING_PKGS
    done_parts+=("installed: $NI_MISSING_PKGS")
    profile_set NI_MISSING_PKGS ""
  fi

  # Debian/Ubuntu ship fd as `fdfind`.
  if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd
  fi

  if [[ "$NI_HOST_MODE" == fresh ]] && (( NI_SWAP_PLAN_MB > 0 )) && ! swapon --show=NAME --noheadings | grep -q .; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l "${NI_SWAP_PLAN_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$NI_SWAP_PLAN_MB" status=none
      chmod 600 /swapfile
      mkswap /swapfile >>"$NI_LOG_FILE" 2>&1
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    echo 'vm.swappiness=10' >/etc/sysctl.d/90-nicode-swap.conf
    sysctl -q -p /etc/sysctl.d/90-nicode-swap.conf || true
    done_parts+=("${NI_SWAP_PLAN_MB} MB swap")
    profile_set NI_SWAP_PLAN_MB 0
  fi

  if [[ "$NI_HOST_MODE" == fresh && "$NI_PLATFORM" != wsl && "$NI_PLATFORM" != container ]]; then
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  fi

  (( ${#done_parts[@]} )) || done_parts+=("nothing to change")
  step_detail "$(join_by ', ' "${done_parts[@]}")"
}

# ───── lib/02-user.sh ─────
# Step 2 — the non-root user that owns projects, Claude Code and the daemon.

step_user() {
  local notes=()

  # Reusing root (it already holds the Claude login and the code): only make sure niCode's dirs exist.
  if [[ "$NI_USER" == root ]]; then
    install -d -m 755 "$NI_PROJECTS_ROOT" /root/.nicode
    install -d -m 700 /root/.config/nicode
    [[ -f /root/.tmux.conf ]] || tmpl_tmux_conf >/root/.tmux.conf
    step_detail "reusing root (existing Claude login/files)"
    return 0
  fi

  if (( ! NI_USER_EXISTS )); then
    adduser --disabled-password --gecos "" "$NI_USER" >>"$NI_LOG_FILE" 2>&1
    notes+=("created $NI_USER")
  else
    notes+=("reused $NI_USER")
  fi
  local home; home="$(getent passwd "$NI_USER" | cut -d: -f6)"
  profile_set NI_USER_EXISTS 1
  profile_set NI_USER_HOME "$home"

  usermod -aG sudo "$NI_USER"
  # The user has no password (key-only), so sudo must be passwordless to be usable at all.
  # Set NICODE_SUDO_NOPASSWD=0 to opt out (the agent then can't sudo either).
  if [[ "${NICODE_SUDO_NOPASSWD:-1}" == 1 ]]; then
    local f="/etc/sudoers.d/90-nicode-${NI_USER}"
    echo "${NI_USER} ALL=(ALL) NOPASSWD:ALL" >"$f.tmp"
    chmod 440 "$f.tmp"
    visudo -cf "$f.tmp" >/dev/null && mv "$f.tmp" "$f"
  fi

  if (( ! NI_USER_HAS_KEYS && NI_ROOT_HAS_KEYS )); then
    install -d -m 700 -o "$NI_USER" -g "$NI_USER" "$home/.ssh"
    install -m 600 -o "$NI_USER" -g "$NI_USER" /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
    profile_set NI_USER_HAS_KEYS 1
    notes+=("copied root SSH keys")
  fi

  [[ "$NI_HAS_SYSTEMD" == 1 ]] && loginctl enable-linger "$NI_USER" 2>/dev/null || true

  install -d -m 755 -o "$NI_USER" -g "$NI_USER" "$home/.config" "$home/.nicode"
  # Existing project folders (e.g. /var/www) are left as they are; only a missing one is created.
  [[ -d "$NI_PROJECTS_ROOT" ]] || install -d -m 755 -o "$NI_USER" -g "$NI_USER" "$NI_PROJECTS_ROOT"
  install -d -m 700 -o "$NI_USER" -g "$NI_USER" "$home/.config/nicode"

  if [[ ! -f "$home/.tmux.conf" ]]; then
    tmpl_tmux_conf >"$home/.tmux.conf"
    chown "$NI_USER:$NI_USER" "$home/.tmux.conf"
  fi

  step_detail "$(join_by ', ' "${notes[@]}")"
}

# ───── lib/03-harden.sh ─────
# Step 3 — SSH lockdown, firewall, fail2ban.
#   fresh host    : key-only SSH (only if a key login is confirmed), ufw 22/80/443, fail2ban.
#   existing host : SSH and fail2ban untouched; an ACTIVE ufw just gets 80/443 opened;
#                   an inactive ufw stays off (enabling it could cut off other services).

step_harden() {
  if [[ "$NI_PLATFORM" == wsl || "$NI_PLATFORM" == container ]]; then
    step_detail "not applicable on $NI_PLATFORM"; return 2
  fi
  if [[ "$NI_HOST_MODE" == existing ]]; then
    _harden_existing
    return
  fi
  local notes=()

  if command -v sshd >/dev/null 2>&1; then
    local dropin=/etc/ssh/sshd_config.d/10-nicode.conf root_login=""
    if [[ "$NI_USER" == root ]]; then
      (( NI_ROOT_HAS_KEYS )) && root_login=prohibit-password
    elif (( NI_USER_HAS_KEYS )); then
      root_login=no
    elif (( NI_ROOT_HAS_KEYS )); then
      root_login=prohibit-password
    fi
    if [[ -n "$root_login" ]]; then
      tmpl_sshd_dropin "$root_login" >"$dropin"
      if sshd -t >>"$NI_LOG_FILE" 2>&1; then
        systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
        notes+=("key-only SSH (root: $root_login)")
      else
        rm -f "$dropin"
        log_warn "sshd rejected the hardening config; left SSH unchanged."
      fi
    else
      log_warn "No SSH keys found for $NI_USER or root — keeping password login to avoid a lockout."
      notes+=("SSH unchanged (no keys found)")
    fi
  fi

  ufw allow OpenSSH >>"$NI_LOG_FILE" 2>&1
  if [[ "$NICODE_TRANSPORT" == https ]]; then
    ufw allow 80/tcp >>"$NI_LOG_FILE" 2>&1
    ufw allow 443/tcp >>"$NI_LOG_FILE" 2>&1
  fi
  # Belt and braces: keep anything else that is already listening publicly reachable.
  local p
  for p in $NI_OTHER_PORTS; do ufw allow "$p/tcp" >>"$NI_LOG_FILE" 2>&1; done
  ufw --force enable >>"$NI_LOG_FILE" 2>&1
  profile_set NI_UFW_ACTIVE 1
  notes+=("ufw on")

  systemctl enable --now fail2ban >>"$NI_LOG_FILE" 2>&1 && notes+=("fail2ban on")

  step_detail "$(join_by ', ' "${notes[@]}")"
}

_harden_existing() {
  if (( NI_UFW_ACTIVE )) && [[ "$NICODE_TRANSPORT" == https ]]; then
    ufw allow 80/tcp >>"$NI_LOG_FILE" 2>&1
    ufw allow 443/tcp >>"$NI_LOG_FILE" 2>&1
    step_detail "existing server: SSH untouched; opened 80/443 in your active ufw"
    return 0
  fi
  step_detail "existing server: SSH and firewall left as they are"
  return 2
}

# ───── lib/04-edge.sh ─────
# Step 4 — how the phone reaches the daemon.
#   https     : Caddy + automatic Let's Encrypt cert on <ip-dashed>.sslip.io (or NICODE_DOMAIN)
#   tailscale : join the tailnet; daemon binds to the Tailscale IP
#   local     : nothing to do (dev / WSL)

step_edge() {
  case "$NICODE_TRANSPORT" in
    https)
      case "$NI_EDGE" in
        nginx)    _edge_nginx ;;
        conflict) step_detail "ports 80/443 are used by ${NI_WEB_SERVER#other:}; rerun with --transport tailscale"; return 1 ;;
        *)        _edge_caddy ;;
      esac ;;
    tailscale) _edge_tailscale ;;
    local)     step_detail "local transport: ws://${NI_PUBLIC_HOST}:${NI_PORT}"; return 2 ;;
    *)         step_detail "unknown transport: $NICODE_TRANSPORT"; return 1 ;;
  esac
}

_edge_caddy() {
  [[ -n "$NI_PUBLIC_HOST" ]] || { step_detail "no public IP/domain detected"; return 1; }
  local fresh=0
  if ! command -v caddy >/dev/null 2>&1; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      >/etc/apt/sources.list.d/caddy-stable.list
    run_logged "${NI_APT[@]}" update
    run_logged "${NI_APT[@]}" install caddy
    fresh=1
    profile_set NI_CADDY_INSTALLED 1
  fi

  tmpl_caddy_site "$NI_PUBLIC_HOST" "$NI_PORT" "$NICODE_SETUP_ID" >/etc/caddy/nicode.caddy
  if (( fresh )) || grep -q '/usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null; then
    # Stock Caddyfile (welcome page) — replace it.
    printf '# Managed by niCode installer\nimport /etc/caddy/nicode.caddy\n' >/etc/caddy/Caddyfile
  elif ! grep -q 'import /etc/caddy/nicode.caddy' /etc/caddy/Caddyfile; then
    printf '\nimport /etc/caddy/nicode.caddy\n' >>/etc/caddy/Caddyfile
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >>"$NI_LOG_FILE" 2>&1
  systemctl enable caddy >>"$NI_LOG_FILE" 2>&1
  systemctl reload caddy >>"$NI_LOG_FILE" 2>&1 || systemctl restart caddy >>"$NI_LOG_FILE" 2>&1

  # Wait for the certificate so the app's progress view goes live. Not fatal: Caddy keeps retrying.
  local i
  for i in $(seq 1 45); do
    if curl -fsS --max-time 3 "https://${NI_PUBLIC_HOST}/setup/status?sid=${NICODE_SETUP_ID}" >/dev/null 2>&1; then
      step_detail "https://${NI_PUBLIC_HOST} (certificate OK)"
      return 0
    fi
    sleep 2
  done
  log_warn "TLS certificate for ${NI_PUBLIC_HOST} not ready yet; Caddy will keep retrying. Check: journalctl -u caddy"
  step_detail "https://${NI_PUBLIC_HOST} (certificate pending)"
}

# Existing nginx owns 80/443 (typical for a droplet already hosting sites): add one extra
# server block for the sslip.io name and let certbot add TLS to it. Other sites are untouched.
_edge_nginx() {
  [[ -n "$NI_PUBLIC_HOST" ]] || { step_detail "no public IP/domain detected"; return 1; }
  local site=/etc/nginx/sites-available/nicode.conf
  if ! command -v certbot >/dev/null 2>&1; then
    run_logged "${NI_APT[@]}" install certbot python3-certbot-nginx
  fi
  # Only write the plain-HTTP block once; afterwards certbot owns the TLS parts of the file.
  if [[ ! -f "$site" ]] || ! grep -q "server_name $NI_PUBLIC_HOST;" "$site"; then
    tmpl_nginx_site "$NI_PUBLIC_HOST" "$NI_PORT" "$NICODE_SETUP_ID" >"$site"
  else
    # Refresh port / setup id in place on re-runs.
    sed -i -E \
      -e 's#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:'"${NI_PORT}"';#' \
      -e 's#(\$arg_sid != ")[^"]*"#\1'"${NICODE_SETUP_ID}"'"#' \
      "$site"
  fi
  ln -sf "$site" /etc/nginx/sites-enabled/nicode.conf
  nginx -t >>"$NI_LOG_FILE" 2>&1 || { rm -f /etc/nginx/sites-enabled/nicode.conf; step_detail "nginx rejected the niCode site; see log"; return 1; }
  systemctl reload nginx
  if ! grep -q 'ssl_certificate' "$site"; then
    run_logged certbot --nginx -d "$NI_PUBLIC_HOST" --non-interactive --agree-tos \
      --register-unsafely-without-email --redirect \
      || { step_detail "certbot failed for $NI_PUBLIC_HOST; see log"; return 1; }
  fi
  step_detail "https://${NI_PUBLIC_HOST} via your existing nginx"
}

_edge_tailscale() {
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh -o "$NI_TMP/tailscale.sh"
    run_logged sh "$NI_TMP/tailscale.sh"
  fi
  if ! tailscale status >/dev/null 2>&1; then
    if [[ -n "${NICODE_TS_AUTHKEY:-}" ]]; then
      tailscale up --authkey "$NICODE_TS_AUTHKEY" --hostname "${NI_HOSTNAME}" >>"$NI_LOG_FILE" 2>&1
    elif ui_interactive; then
      log_info "Open the URL below to add this server to your tailnet:"
      tailscale up --hostname "${NI_HOSTNAME}"
    else
      step_detail "Tailscale needs --ts-authkey in unattended mode"; return 1
    fi
  fi
  local ip; ip="$(tailscale ip -4 | head -n1)"
  profile_set NI_PUBLIC_HOST "$ip"
  profile_set NI_TAILSCALE_UP 1
  step_detail "tailnet IP $ip"
}

# ───── lib/05-node.sh ─────
# Step 5 — Node.js for the daemon (needs >= 20).
#   An existing Node 20+ is reused as-is.
#   fresh host    : Node 22 LTS system-wide via NodeSource.
#   existing host : a private Node 22 in /opt/nicode/node — the system Node your apps use
#                   (if any) is never replaced or upgraded.

NI_PRIVATE_NODE_DIR=/opt/nicode/node

step_node() {
  if (( NI_NODE_OK )); then
    step_detail "using existing Node v$NI_NODE_VERSION ($NI_NODE_BIN)"
    return 2
  fi
  if [[ "$NI_HOST_MODE" == existing ]]; then
    _node_private
    return
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NI_TMP/nodesource.sh"
  run_logged bash "$NI_TMP/nodesource.sh"
  run_logged "${NI_APT[@]}" install nodejs
  local v; v="$(node -v | tr -d v)"
  profile_set NI_NODE_VERSION "$v"
  profile_set NI_NODE_BIN "$(command -v node)"
  profile_set NI_NODE_OK 1
  step_detail "v$v"
}

_node_private() {
  local arch=x64 ver tarball
  [[ "$NI_ARCH" == arm64 ]] && arch=arm64
  # Latest 22.x from the official index.
  ver="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" | head -n1)"
  [[ -n "$ver" ]] || { step_detail "could not resolve the latest Node 22 build"; return 1; }
  tarball="$NI_TMP/$ver"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$ver" -o "$tarball"
  (cd "$NI_TMP" && curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $ver\$" | sha256sum -c - >>"$NI_LOG_FILE" 2>&1) \
    || { step_detail "Node download failed checksum"; return 1; }
  rm -rf "$NI_PRIVATE_NODE_DIR"
  install -d "$NI_PRIVATE_NODE_DIR"
  tar -xJf "$tarball" -C "$NI_PRIVATE_NODE_DIR" --strip-components=1
  local v; v="$("$NI_PRIVATE_NODE_DIR/bin/node" -v | tr -d v)"
  profile_set NI_NODE_VERSION "$v"
  profile_set NI_NODE_BIN "$NI_PRIVATE_NODE_DIR/bin/node"
  profile_set NI_NODE_OK 1
  step_detail "private Node v$v in $NI_PRIVATE_NODE_DIR (system Node untouched)"
}

# ───── lib/06-claude.sh ─────
# Step 6 — Claude Code CLI for the target user. Login is NOT done here: it happens from the app
# (daemon setup API) or with `nicode login`, because OAuth needs a browser.

step_claude() {
  local notes=()
  local bin="$NI_CLAUDE_BIN" ver
  if [[ -z "$bin" ]]; then
    # Native installer (self-updating, lives in ~/.local/bin). Optional pinned version.
    if ! as_user "curl -fsSL https://claude.ai/install.sh | bash -s -- ${NICODE_CLAUDE_VERSION:-}"; then
      log_warn "Native Claude installer failed; falling back to npm."
      run_logged npm install -g "@anthropic-ai/claude-code${NICODE_CLAUDE_VERSION:+@$NICODE_CLAUDE_VERSION}"
    fi
    notes+=("installed")
    # Make sure ~/.local/bin is on PATH for login shells (tmux, daemon-spawned shells).
    as_user 'grep -q "HOME/.local/bin" ~/.profile 2>/dev/null || echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.profile'
    bin="$(_find_claude_bin "$NI_USER_HOME")"
  else
    notes+=("found $bin")
  fi
  [[ -n "$bin" ]] || { step_detail "claude binary not found after install"; return 1; }
  ver="$(as_user_capture "$(printf '%q' "$bin") --version" | head -n1)"
  profile_set NI_CLAUDE_BIN "$bin"
  profile_set NI_CLAUDE_VERSION "$ver"

  # Env file the daemon loads (holds CLAUDE_CODE_OAUTH_TOKEN after login).
  local envf="$NI_USER_HOME/.config/nicode/env"
  if [[ ! -f "$envf" ]]; then
    printf '# niCode daemon environment. CLAUDE_CODE_OAUTH_TOKEN is written by the app login or `nicode login`.\n' >"$envf"
    chown "$NI_USER:" "$envf"
    chmod 600 "$envf"
  fi

  if (( NI_CLAUDE_AUTHED )); then notes+=("$ver, logged in"); else notes+=("$ver, login pending"); fi
  step_detail "$(join_by ', ' "${notes[@]}")"
}

# ───── lib/07-git.sh ─────
# Step 7 — GitHub CLI + sane git defaults. GitHub login happens from the app (device flow).

step_git() {
  local notes=()
  if (( ! NI_GH_INSTALLED )); then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      >/etc/apt/sources.list.d/github-cli.list
    run_logged "${NI_APT[@]}" update
    run_logged "${NI_APT[@]}" install gh
    profile_set NI_GH_INSTALLED 1
    notes+=("gh installed")
  fi

  as_user 'git config --global init.defaultBranch main; git config --global pull.rebase false'
  if [[ -n "${NICODE_GIT_NAME:-}" && -z "$NI_GIT_NAME" ]]; then
    as_user "git config --global user.name $(printf '%q' "$NICODE_GIT_NAME")"
    profile_set NI_GIT_NAME "$NICODE_GIT_NAME"
  fi
  if [[ -n "${NICODE_GIT_EMAIL:-}" && -z "$NI_GIT_EMAIL" ]]; then
    as_user "git config --global user.email $(printf '%q' "$NICODE_GIT_EMAIL")"
    profile_set NI_GIT_EMAIL "$NICODE_GIT_EMAIL"
  fi
  (( NI_GH_AUTHED )) && as_user 'gh auth setup-git' && notes+=("gh logged in")
  [[ -n "$NI_GIT_NAME" ]] && notes+=("identity: $NI_GIT_NAME") || notes+=("identity from GitHub login later")

  step_detail "$(join_by ', ' "${notes[@]}")"
}

# ───── lib/08-daemon.sh ─────
# Step 8 — fetch + build server/, write config, run as a systemd service.

NI_APP_DIR="${NI_APP_DIR:-/opt/nicode}"

step_daemon() {
  local src cfg_dir cfg token="" bind

  # 1. Source: a local checkout (dev, e.g. WSL → /mnt/c/...) or a clone of NICODE_REPO@NICODE_REF.
  if [[ -n "${NICODE_SOURCE_DIR:-}" ]]; then
    src="$NICODE_SOURCE_DIR"
  else
    src="$NI_APP_DIR"
    install -d -o "$NI_USER" -g "$NI_USER" "$src"
    if [[ -d "$src/.git" ]]; then
      as_user "git -C '$src' fetch --depth 1 origin '$NICODE_REF' && git -C '$src' reset --hard FETCH_HEAD"
    else
      as_user "git clone --depth 1 --branch '$NICODE_REF' '$NICODE_REPO' '$src'"
    fi
  fi
  if [[ ! -f "$src/server/package.json" ]]; then
    step_detail "server/ not published in $NICODE_REPO@$NICODE_REF yet — skipped"
    profile_set NI_DAEMON_INSTALLED 0
    return 2
  fi

  # 2. Build.
  # Build with the Node chosen in the node step (may be a private one in /opt/nicode/node).
  as_user "export PATH='$(dirname "$NI_NODE_BIN")':\$PATH; cd '$src/server' && npm ci --no-audit --no-fund && npm run build"

  # 3. Config. One hashed token per paired device (`nicode token add/list/revoke`).
  #    Existing devices are kept; an app-supplied token is added; a first install with no
  #    token gets an "installer" device whose token is shown as a QR at the end.
  cfg_dir="$NI_USER_HOME/.config/nicode"
  cfg="$cfg_dir/config.json"
  local tokens='[]' hash
  [[ -f "$cfg" ]] && tokens="$(jq -c '.tokens // []' "$cfg")"
  if [[ -n "${NICODE_TOKEN:-}" ]]; then
    token="$NICODE_TOKEN"
  elif [[ "$tokens" == '[]' ]]; then
    token="$(openssl rand -hex 32)"
    printf '%s' "$token" >"$NI_TMP/pair_token"; chmod 600 "$NI_TMP/pair_token"
  fi
  if [[ -n "$token" ]]; then
    hash="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
    tokens="$(jq -c --arg h "$hash" --arg n "${NICODE_DEVICE_NAME:-${NICODE_TOKEN:+app}}" --arg id "d_$(openssl rand -hex 4)" \
      'if any(.[]; .sha256 == $h) then . else . + [{id: $id, name: (if $n == "" then "installer" else $n end), sha256: $h, createdAt: (now | todate)}] end' <<<"$tokens")"
  fi

  case "$NICODE_TRANSPORT" in
    https)     bind=127.0.0.1 ;;
    tailscale) bind="$NI_PUBLIC_HOST" ;;
    local)     bind=0.0.0.0 ;;
  esac
  tmpl_daemon_config "$bind" "$tokens" "$src" >"$cfg.tmp"
  chown "$NI_USER:" "$cfg.tmp"; chmod 600 "$cfg.tmp"; mv -f "$cfg.tmp" "$cfg"

  # 4. Service.
  if [[ "$NI_HAS_SYSTEMD" != 1 ]]; then
    step_detail "built; no systemd — start manually: NICODE_CONFIG=$cfg node $src/server"
    profile_set NI_DAEMON_INSTALLED 0
    return 0
  fi
  tmpl_systemd_unit "$src" "$cfg" >/etc/systemd/system/nicode.service
  systemctl daemon-reload
  systemctl enable nicode >>"$NI_LOG_FILE" 2>&1
  systemctl restart nicode

  local i ok=0
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://${bind/0.0.0.0/127.0.0.1}:${NI_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  (( ok )) || { step_detail "daemon did not answer /health — journalctl -u nicode"; return 1; }
  profile_set NI_DAEMON_INSTALLED 1
  step_detail "running on ${bind}:${NI_PORT}"
}

# ───── lib/09-finish.sh ─────
# Step 9 — final state, MOTD, cleanup of one-time secrets, summary + pairing QR.

step_finish() {
  local state
  if [[ "$NICODE_STAGE" == base || "$NI_DAEMON_INSTALLED" != 1 ]]; then
    state=base_ready
  elif (( NI_CLAUDE_AUTHED )); then
    state=ready
  else
    state=needs_claude_login
  fi
  # Written to a file because this runs in a subshell; install.sh applies it.
  echo "$state" >"$NI_TMP/final_state"

  if [[ -d /etc/update-motd.d ]]; then
    printf '#!/bin/sh\n/usr/local/bin/nicode motd 2>/dev/null || true\n' >/etc/update-motd.d/99-nicode
    chmod 755 /etc/update-motd.d/99-nicode
  fi

  # The answers file from cloud-init held the initial token; the app rotates it after setup anyway.
  if [[ -n "${NI_CONFIG_FILE:-}" && -f "$NI_CONFIG_FILE" ]] && grep -q '^NICODE_TOKEN=' "$NI_CONFIG_FILE"; then
    shred -u "$NI_CONFIG_FILE" 2>/dev/null || rm -f "$NI_CONFIG_FILE"
  fi

  step_detail "$state"
}

# Printed by install.sh after all steps (outside the step subshell so it reaches the terminal).
finish_summary() {
  local state="$1"
  echo
  printf '%s niCode %s %s\n' "$C_BOLD" "$state" "$C_RESET"
  printf '  Host:       %s (%s)\n' "${NI_PUBLIC_HOST:-?}" "$NICODE_TRANSPORT"
  printf '  User:       %s   projects: %s\n' "$NI_USER" "$NI_PROJECTS_ROOT"
  printf '  Log:        %s\n' "$NI_LOG_FILE"
  printf '  Manage:     nicode status | doctor | login | logs | update\n'
  if [[ -f "$NI_TMP/pair_token" ]]; then
    echo
    /usr/local/bin/nicode _pair-print "$(cat "$NI_TMP/pair_token")" || true
  fi
  case "$state" in
    base_ready)         printf '\n  Next: once server/ is published, run  sudo nicode update  (installs the daemon).\n' ;;
    needs_claude_login) printf '\n  Next: open the niCode app to log in to Claude — or run  nicode login  here.\n' ;;
  esac
  echo
}

# ───── lib/detect.sh ─────
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
  # The daemon supports Node >= 20, so an existing Node 20+ is reused rather than replaced.
  [[ -n "$NI_NODE_VERSION" ]] && (( ${NI_NODE_VERSION%%.*} >= 20 )) && NI_NODE_OK=1
  NI_NODE_BIN="$(command -v node 2>/dev/null || true)"

  NI_CLAUDE_BIN="$(_find_claude_bin "$NI_USER_HOME")"
  NI_CLAUDE_VERSION=""
  [[ -n "$NI_CLAUDE_BIN" ]] && NI_CLAUDE_VERSION="$(_user_cmd "$(printf '%q' "$NI_CLAUDE_BIN") --version" | head -n1)"
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

# Public TCP listeners other than SSH/HTTP(S) (game servers, databases, apps…).
# A firewall that only allows 22/80/443 would cut these off.
_detect_other_ports() {
  NI_OTHER_PORTS="$( { ss -ltnH 2>/dev/null || true; } | awk '{print $4}' \
    | { grep -vE '^(127\.|\[::1\]|::1)' || true; } | sed -E 's/.*:([0-9]+)$/\1/' \
    | { grep -vxE '22|80|443|53' || true; } | sort -un | tr '\n' ' ')"
  NI_OTHER_PORTS="${NI_OTHER_PORTS% }"
  return 0
}

# "existing" = this machine already does real work. In that mode the installer only adds
# niCode and changes nothing shared: no apt upgrade, no SSH/firewall changes, no system Node swap.
_detect_host_mode() {
  NI_HOST_MODE=fresh; NI_HOST_MODE_WHY=""
  local why=()
  [[ "$NI_WEB_SERVER" != none ]] && why+=("web server: ${NI_WEB_SERVER#other:}")
  [[ -n "$NI_OTHER_PORTS" ]] && why+=("services on ports $NI_OTHER_PORTS")
  (( ${NI_PROJECTS_FOUND:-0} > 0 )) && why+=("${NI_PROJECTS_FOUND} git repos")
  (( NI_CLAUDE_AUTHED )) && why+=("Claude already set up")
  if [[ -n "${NICODE_HOST_MODE:-}" ]]; then
    NI_HOST_MODE="$NICODE_HOST_MODE"; NI_HOST_MODE_WHY="set by --host-mode"
  elif (( ${#why[@]} )); then
    NI_HOST_MODE=existing; NI_HOST_MODE_WHY="$(IFS=','; echo "${why[*]}")"
  fi
  return 0
}

# Finds the claude binary even when it lives somewhere a non-interactive login shell
# doesn't put on PATH (npm global under nvm, ~/.claude/local, bun…).
_find_claude_bin() {
  local home="$1" c
  c="$(_user_cmd 'command -v claude')"
  [[ -n "$c" ]] && { echo "$c"; return; }
  for c in "$home/.local/bin/claude" "$home/.claude/local/claude" "$home/.npm-global/bin/claude" \
           "$home/.bun/bin/claude" /usr/local/bin/claude /usr/bin/claude "$home"/.nvm/versions/node/*/bin/claude; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
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
  NI_WEB_SERVER NI_EDGE NI_OTHER_PORTS NI_HOST_MODE NI_HOST_MODE_WHY NI_NODE_BIN
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
  _detect_other_ports
  _detect_host_mode
  local v
  {
    echo "# niCode host profile — generated $(date -u +%FT%TZ) by detect.sh"
    for v in "${NI_PROFILE_VARS[@]}"; do printf '%s=%q\n' "$v" "${!v:-}"; done
  } >"$NI_PROFILE_FILE"
}

# Human-readable "found / will do" text for the review screen and `nicode doctor`.
detect_plan_text() {
  local yes="✔" todo="➜" na="–" s line existing=0
  [[ "$NI_HOST_MODE" == existing ]] && existing=1
  printf 'FOUND\n'
  printf '  Host       %s (%s), %s %s, %s\n' "$NI_HOSTNAME" "$NI_PLATFORM${NI_REGION:+ $NI_REGION}" "$NI_OS_ID" "$NI_OS_VERSION" "$NI_ARCH"
  printf '  Mode       %s\n' "$( (( existing )) && echo "EXISTING server ($NI_HOST_MODE_WHY): only adds niCode, changes nothing shared" || echo "fresh server: full setup")"
  printf '  Resources  %s vCPU, %s MB RAM, %s MB swap, %s GB free disk\n' "$NI_CPUS" "$NI_RAM_MB" "$NI_SWAP_MB" "$NI_DISK_FREE_GB"
  printf '  Address    %s → %s (%s)\n' "${NI_PUBLIC_IP:-${NI_LAN_IP:-?}}" "${NI_PUBLIC_HOST:-?}" "$NICODE_TRANSPORT"
  printf '  Web server %s%s\n' "${NI_WEB_SERVER#other:}" "$( [[ -n "$NI_OTHER_PORTS" ]] && echo "; other public ports: $NI_OTHER_PORTS" || true)"
  printf '  User       %s (%s)\n' "$NI_USER" "$NI_USER_SOURCE"
  printf '  Projects   %s%s\n' "$NI_PROJECTS_ROOT" "$( (( ${NI_PROJECTS_FOUND:-0} )) && echo " (${NI_PROJECTS_FOUND} git repos found)" || true)"
  if [[ -n "$NI_NODE_VERSION" ]]; then printf '  Node       v%s (%s)\n' "$NI_NODE_VERSION" "$NI_NODE_BIN"
  else printf '  Node       not installed\n'; fi
  printf '  Claude     %s%s\n' "${NI_CLAUDE_VERSION:-not installed}${NI_CLAUDE_BIN:+ ($NI_CLAUDE_BIN)}" "$( (( NI_CLAUDE_AUTHED )) && echo ', logged in' || true)"
  printf '  GitHub CLI %s\n' "$( (( NI_GH_AUTHED )) && echo 'logged in' || { (( NI_GH_INSTALLED )) && echo 'installed' || echo 'not installed'; })"
  printf '\nPLAN  (stage: %s)\n' "$NICODE_STAGE"
  for s in $(steps_selected); do
    [[ "$s" == detect ]] && continue
    line=""
    case "$s" in
      system)
        if (( existing )); then
          if [[ -n "$NI_MISSING_PKGS" ]]; then line="$todo|install only: $NI_MISSING_PKGS (no upgrade, no swap)"
          else line="$yes|nothing missing (no upgrade, no swap)"; fi
        else
          if [[ -z "$NI_MISSING_PKGS" && "$NI_SWAP_PLAN_MB" == 0 ]]; then line="$yes|upgrade only, nothing missing"
          else line="$todo|upgrade; install: ${NI_MISSING_PKGS:-–}$( (( NI_SWAP_PLAN_MB )) && echo "; ${NI_SWAP_PLAN_MB} MB swap" || true)"; fi
        fi ;;
      user)
        if (( NI_USER_EXISTS )); then line="$yes|reuse $NI_USER"
        else line="$todo|create $NI_USER$( (( NI_ROOT_HAS_KEYS )) && echo ' (copy root SSH keys)' || true)"; fi ;;
      harden)
        if [[ "$NI_PLATFORM" == wsl || "$NI_PLATFORM" == container ]]; then line="$na|not applicable ($NI_PLATFORM)"
        elif (( existing )); then
          if (( NI_UFW_ACTIVE )) && [[ "$NICODE_TRANSPORT" == https ]]; then line="$todo|SSH untouched; open 80/443 in your active ufw"
          else line="$na|SSH and firewall left as they are"; fi
        else line="$todo|key-only SSH, ufw 22/80/443${NI_OTHER_PORTS:+ + $NI_OTHER_PORTS}, fail2ban"; fi ;;
      edge)
        case "$NICODE_TRANSPORT" in
          https)
            case "$NI_EDGE" in
              nginx)    line="$todo|add one site to your existing nginx + certbot for $NI_PUBLIC_HOST" ;;
              conflict) line="✗|ports 80/443 are used by ${NI_WEB_SERVER#other:}: rerun with --transport tailscale (docs/01)" ;;
              *)        line="$todo|Caddy + Let's Encrypt for $NI_PUBLIC_HOST" ;;
            esac ;;
          tailscale) line="$todo|Tailscale (no public port)" ;;
          local)     line="$na|local dev: plain ws:// on $NI_PUBLIC_HOST" ;;
        esac ;;
      node)
        if (( NI_NODE_OK )); then line="$yes|use existing v$NI_NODE_VERSION"
        elif (( existing )); then line="$todo|private Node 22 in /opt/nicode/node (system Node untouched)"
        else line="$todo|install Node 22 LTS"; fi ;;
      claude)
        if [[ -n "$NI_CLAUDE_BIN" ]]; then line="$yes|use existing$( (( NI_CLAUDE_AUTHED )) && echo ' (logged in — no login needed)' || echo ' (login from the app afterwards)')"
        else line="$todo|install for $NI_USER$( (( NI_CLAUDE_AUTHED )) && echo ' (existing login reused)' || echo ' (login from the app afterwards)')"; fi ;;
      git)
        if (( NI_GH_INSTALLED )); then line="$yes|gh present"; else line="$todo|install GitHub CLI, git defaults"; fi ;;
      daemon) line="$todo|build & run on 127.0.0.1:$NI_PORT" ;;
      finish) line="$todo|summary$( [[ "$NICODE_STAGE" == full ]] && echo ' + pairing QR' || true)" ;;
    esac
    printf '  %s %-26s %s\n' "${line%%|*}" "${NI_STEP_TITLE[$s]}" "${line#*|}"
  done
  if (( NI_RAM_MB > 0 && NI_RAM_MB < 1900 )); then printf '\n  ⚠ Less than 2 GB RAM: Claude Code + builds may be slow.\n'; fi
  if (( NI_DISK_FREE_GB > 0 && NI_DISK_FREE_GB < 10 )); then printf '  ⚠ Less than 10 GB free disk.\n'; fi
  if [[ "$NI_USER" == root ]]; then printf '\n  ⚠ Runs as root to reuse your existing Claude login and files. Use --no-root for a separate "dev" user.\n'; fi
  if [[ "$NICODE_TRANSPORT" == local ]]; then printf '\n  ℹ Local transport: no TLS. Use only on a trusted LAN / for development.\n'; fi
  return 0
}

# ───── lib/state.sh ─────
# Step bookkeeping: completion markers, persisted install settings, step runner.

NI_STATE_DIR="${NI_STATE_DIR:-/var/lib/nicode}"
NI_ETC_DIR="${NI_ETC_DIR:-/etc/nicode}"
NI_SETTINGS_FILE="$NI_ETC_DIR/install.env"

# Ordered step ids + titles. Stage "base" omits "daemon".
NI_ALL_STEPS=(detect system user harden edge node claude git daemon finish)
declare -A NI_STEP_TITLE=(
  [detect]="Detect host"
  [system]="System packages & swap"
  [user]="Developer user"
  [harden]="SSH & firewall hardening"
  [edge]="HTTPS endpoint"
  [node]="Node.js"
  [claude]="Claude Code"
  [git]="Git & GitHub CLI"
  [daemon]="niCode daemon"
  [finish]="Finish"
)

state_init() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  mkdir -p "$NI_STATE_DIR/done" "$NI_STATE_DIR/public" "$NI_ETC_DIR"
  chmod 755 "$NI_STATE_DIR" "$NI_STATE_DIR/public"
  touch "$NI_LOG_FILE" && chmod 600 "$NI_LOG_FILE"
}

step_is_done()   { [[ -f "$NI_STATE_DIR/done/$1" ]]; }
step_mark_done() { [[ -n "${NI_DRY_RUN:-}" ]] || date -u +%FT%TZ >"$NI_STATE_DIR/done/$1"; }
step_clear()     { rm -f "$NI_STATE_DIR/done/$1"; }

# Settings that must survive re-runs (`nicode update`, `--resume`). Never holds secrets.
NI_PERSISTED_VARS=(NICODE_REPO NICODE_REF NICODE_INSTALLER_URL NICODE_TRANSPORT NICODE_STAGE NICODE_SETUP_ID NICODE_USER NICODE_PORT NICODE_DOMAIN NICODE_PROJECTS_ROOT NICODE_NO_ROOT)

settings_load() {
  # shellcheck disable=SC1090
  [[ -f "$NI_SETTINGS_FILE" ]] && source "$NI_SETTINGS_FILE"
  return 0
}

settings_save() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  local v
  {
    echo "# niCode installer settings (generated). Safe to edit; no secrets here."
    for v in "${NI_PERSISTED_VARS[@]}"; do
      [[ -n "${!v:-}" ]] && printf '%s=%q\n' "$v" "${!v}"
    done
  } >"$NI_SETTINGS_FILE"
  chmod 644 "$NI_SETTINGS_FILE"
}

# Which steps run for the current stage / --only / --skip.
steps_selected() {
  local s
  for s in "${NI_ALL_STEPS[@]}"; do
    if [[ "${NICODE_STAGE}" == "base" && "$s" == "daemon" ]]; then continue; fi
    if [[ -n "${NI_ONLY:-}" && ",${NI_ONLY}," != *",$s,"* && "$s" != "detect" ]]; then continue; fi
    if [[ -n "${NI_SKIP:-}" && ",${NI_SKIP}," == *",$s,"* ]]; then continue; fi
    echo "$s"
  done
}

# run_step <id> — calls step_<id>; handles done-markers, status, retries.
# A step function returns 0 (done), 2 (skipped: not applicable / already satisfied), other (failed).
# It may set NI_STEP_DETAIL for the status display.
run_step() {
  local id="$1" title="${NI_STEP_TITLE[$1]}" rc choice
  if [[ "$id" != "detect" && "$id" != "finish" ]] && step_is_done "$id" && [[ ",${NI_REDO:-}," != *",$id,"* ]]; then
    log_ok "$title (already done)"
    status_step "$id" skipped "already done"
    return 0
  fi
  while true; do
    NI_STEP_DETAIL=""
    log_info "$title"
    status_step "$id" running ""
    set +e
    ( set -e; "step_${id}" )
    rc=$?
    set -e
    # Steps run in a subshell so `set -e` aborts only the step. They persist decisions via
    # profile_set (profile file) and details via step_detail (tmp file); pull both back here.
    profile_reload
    if [[ -f "$NI_TMP/detail" ]]; then NI_STEP_DETAIL="$(cat "$NI_TMP/detail")"; rm -f "$NI_TMP/detail"; fi
    case $rc in
      0) step_mark_done "$id"; status_step "$id" "done" "$NI_STEP_DETAIL"; log_ok "$title${NI_STEP_DETAIL:+ — $NI_STEP_DETAIL}"; return 0 ;;
      2) step_mark_done "$id"; status_step "$id" skipped "$NI_STEP_DETAIL"; log_ok "$title — skipped${NI_STEP_DETAIL:+ ($NI_STEP_DETAIL)}"; return 0 ;;
    esac
    status_step "$id" failed "${NI_STEP_DETAIL:-see $NI_LOG_FILE}"
    log_error "$title failed (exit $rc). Log: $NI_LOG_FILE"
    choice="$(ui_failure_menu "$title")"
    case "$choice" in
      retry) continue ;;
      skip)  status_step "$id" skipped "skipped after failure"; return 0 ;;
      *)     status_state error "Step '$title' failed. Re-run with --resume."; exit 1 ;;
    esac
  done
}

# Steps call this to report a short human detail line.
step_detail() { printf '%s' "$*" >"$NI_TMP/detail"; }

# Reload profile values that steps may have changed (e.g. NI_USER after `user`).
profile_reload() {
  # shellcheck disable=SC1090
  [[ -f "$NI_PROFILE_FILE" ]] && source "$NI_PROFILE_FILE"
  return 0
}

profile_set() {
  # profile_set KEY VALUE — update a key in the profile file and current shell.
  local k="$1" v="$2"
  printf -v "$k" '%s' "$v"
  # In dry-run NI_PROFILE_FILE lives in a temp dir, so writing is still safe.
  if grep -q "^${k}=" "$NI_PROFILE_FILE" 2>/dev/null; then
    sed -i "/^${k}=/d" "$NI_PROFILE_FILE"
  fi
  printf '%s=%q\n' "$k" "$v" >>"$NI_PROFILE_FILE"
}

# ───── lib/status.sh ─────
# Writes /var/lib/nicode/public/status.json (schema: SetupStatus in protocol/types.ts).
# Caddy serves it at /setup/status?sid=<setup id> so the app can show live progress.
# Pure bash on purpose: runs before jq is installed.

NI_STATUS_FILE="${NI_STATUS_FILE:-/var/lib/nicode/public/status.json}"
NI_STATUS_STATE="installing"
NI_STATUS_CURRENT=""
NI_STATUS_ERROR=""
declare -A NI_STATUS_STEP=()
declare -A NI_STATUS_DETAIL=()

status_init() {
  local s
  # Keep previous results on --resume so the app doesn't see finished steps flip back to pending.
  if [[ -f "$NI_STATUS_FILE" ]] && command -v jq >/dev/null 2>&1; then
    while IFS=$'\t' read -r id st det; do
      [[ -n "$id" ]] || continue
      NI_STATUS_STEP[$id]="$st"; NI_STATUS_DETAIL[$id]="$det"
    done < <(jq -r '.steps[] | [.id, .status, .detail] | @tsv' "$NI_STATUS_FILE" 2>/dev/null || true)
  fi
  for s in "${NI_ALL_STEPS[@]}"; do
    : "${NI_STATUS_STEP[$s]:=pending}"
    : "${NI_STATUS_DETAIL[$s]:=}"
  done
  NI_STATUS_STATE="installing"
  status_write
}

status_step() {
  local id="$1" st="$2" det="${3:-}"
  NI_STATUS_STEP[$id]="$st"
  NI_STATUS_DETAIL[$id]="$det"
  [[ "$st" == "running" ]] && NI_STATUS_CURRENT="$id"
  status_write
}

status_state() {
  NI_STATUS_STATE="$1"
  NI_STATUS_ERROR="${2:-}"
  [[ "$1" != "error" ]] && NI_STATUS_ERROR=""
  status_write
}

status_write() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  [[ -d "$(dirname "$NI_STATUS_FILE")" ]] || return 0
  local s steps="" sep="" host="null" err="null" cur="null" tmp
  local -a selected
  mapfile -t selected < <(steps_selected)
  for s in "${selected[@]}"; do
    steps+="${sep}{\"id\":\"$s\",\"title\":\"$(json_escape "${NI_STEP_TITLE[$s]}")\",\"status\":\"${NI_STATUS_STEP[$s]:-pending}\",\"detail\":\"$(json_escape "${NI_STATUS_DETAIL[$s]:-}")\"}"
    sep=","
  done
  [[ -n "${NI_PUBLIC_HOST:-}" ]] && host="\"$(json_escape "$NI_PUBLIC_HOST")\""
  [[ -n "$NI_STATUS_ERROR" ]] && err="\"$(json_escape "$NI_STATUS_ERROR")\""
  [[ -n "$NI_STATUS_CURRENT" ]] && cur="\"$NI_STATUS_CURRENT\""
  tmp="$(mktemp "${NI_STATUS_FILE}.XXXX")"
  printf '{"version":1,"state":"%s","step":%s,"steps":[%s],"host":%s,"transport":"%s","updatedAt":"%s","error":%s}\n' \
    "$NI_STATUS_STATE" "$cur" "$steps" "$host" "${NICODE_TRANSPORT:-https}" "$(date -u +%FT%TZ)" "$err" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$NI_STATUS_FILE"
  # The daemon (running as NI_USER) updates state after Claude login, so it must own the file.
  if [[ -n "${NI_USER:-}" ]] && id "$NI_USER" >/dev/null 2>&1; then
    chown "$NI_USER" "$NI_STATUS_FILE" "$(dirname "$NI_STATUS_FILE")" 2>/dev/null || true
  fi
}

# ───── lib/templates.sh ─────
# File templates as functions (heredocs) so the bundled single-file installer stays self-contained.

tmpl_tmux_conf() {
  cat <<'EOF'
# niCode defaults (safe to edit)
set -g mouse on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -sg escape-time 10
set -g status-style "bg=colour235,fg=colour250"
set -g status-right "#H"
EOF
}

# tmpl_sshd_dropin <PermitRootLogin value>
tmpl_sshd_dropin() {
  cat <<EOF
# Managed by niCode installer. Loaded before 50-cloud-init.conf, so these win.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin $1
EOF
}

# tmpl_caddy_site <host> <daemon port> <setup id>
tmpl_caddy_site() {
  cat <<EOF
# Managed by niCode installer — regenerated on every run.
$1 {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}

	# Install progress for the app; only readable with the setup id.
	@status {
		path /setup/status
		query sid=$3
	}
	handle @status {
		root * /var/lib/nicode/public
		rewrite * /status.json
		header Cache-Control "no-store"
		file_server
	}
	handle /setup/status {
		respond 404
	}

	# Everything else (WebSocket /ws, /health) goes to the daemon on localhost.
	handle {
		reverse_proxy 127.0.0.1:$2
	}
}
EOF
}

# tmpl_nginx_site <host> <daemon port> <setup id>  (certbot later adds the TLS listener)
tmpl_nginx_site() {
  cat <<EOF
# Managed by niCode installer (TLS lines added by certbot). Other nginx sites are untouched.
server {
    listen 80;
    listen [::]:80;
    server_name $1;

    # Install progress for the app; only readable with the setup id.
    location = /setup/status {
        if (\$arg_sid != "$3") { return 404; }
        default_type application/json;
        add_header Cache-Control "no-store";
        alias /var/lib/nicode/public/status.json;
    }

    # Everything else (WebSocket /ws, /health) goes to the daemon on localhost.
    location / {
        proxy_pass http://127.0.0.1:$2;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
EOF
}

# tmpl_daemon_config <bindHost> <tokens json array> <source dir>
tmpl_daemon_config() {
  local h="$NI_USER_HOME"
  cat <<EOF
{
  "version": 1,
  "bindHost": "$(json_escape "$1")",
  "port": ${NI_PORT},
  "tokens": $2,
  "transport": "$(json_escape "$NICODE_TRANSPORT")",
  "publicHost": "$(json_escape "${NI_PUBLIC_HOST:-}")",
  "user": "$(json_escape "$NI_USER")",
  "projectsRoot": "$(json_escape "$NI_PROJECTS_ROOT")",
  "dataDir": "$(json_escape "$h/.nicode")",
  "envFile": "$(json_escape "$h/.config/nicode/env")",
  "statusFile": "$(json_escape "$NI_STATUS_FILE")",
  "claudeBin": "$(json_escape "${NI_CLAUDE_BIN:-claude}")",
  "appDir": "$(json_escape "$3")"
}
EOF
}

# tmpl_systemd_unit <source dir> <config path>
tmpl_systemd_unit() {
  local h="$NI_USER_HOME" node_bin claude_dir
  node_bin="${NI_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
  claude_dir="$(dirname "${NI_CLAUDE_BIN:-$h/.local/bin/claude}")"
  cat <<EOF
# Managed by niCode installer.
[Unit]
Description=niCode daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${NI_USER}
Group=${NI_USER}
WorkingDirectory=$1/server
Environment=NODE_ENV=production
Environment=HOME=${h}
Environment=NICODE_CONFIG=$2
Environment=PATH=${claude_dir}:$(dirname "$node_bin"):${h}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-${h}/.config/nicode/env
# node <dir> runs package.json "main" (dist/server/src/index.js, see docs/02).
ExecStart=${node_bin} $1/server
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=2
# tmux servers spawned for terminals must survive daemon restarts/updates.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
}

# ───── lib/ui.sh ─────
# UI helpers: logging, whiptail wrappers with plain-text fallback.

NI_LOG_FILE="${NI_LOG_FILE:-/var/log/nicode-install.log}"

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'
  C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_BLUE=$'\e[34m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

_log_to_file() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$NI_LOG_FILE" 2>/dev/null || true
}

log_info()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; _log_to_file "INFO  $*"; }
log_ok()    { printf '%s ✓%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; _log_to_file "OK    $*"; }
log_warn()  { printf '%s !%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; _log_to_file "WARN  $*"; }
log_error() { printf '%s ✗%s  %s\n' "$C_RED" "$C_RESET" "$*" >&2; _log_to_file "ERROR $*"; }
log_dim()   { printf '%s    %s%s\n' "$C_DIM" "$*" "$C_RESET"; _log_to_file "      $*"; }

die() {
  log_error "$*"
  if declare -f status_state >/dev/null; then status_state error "$*"; fi
  exit 1
}

# Interactive = a human is at a terminal and we were not told to run unattended.
ui_interactive() {
  [[ -z "${NI_UNATTENDED:-}" && -t 0 && -t 1 ]]
}

ui_has_whiptail() {
  command -v whiptail >/dev/null 2>&1
}

# ui_review "<title>" "<body>"  → returns 0 to proceed, 1 to cancel.
ui_review() {
  local title="$1" body="$2"
  if [[ -n "${NI_ASSUME_YES:-}" ]] || ! ui_interactive; then
    printf '%s\n%s\n' "${C_BOLD}${title}${C_RESET}" "$body"
    return 0
  fi
  if ui_has_whiptail; then
    local rows cols
    rows=$(( $(tput lines 2>/dev/null || echo 30) - 4 ))
    cols=$(( $(tput cols 2>/dev/null || echo 100) - 6 ))
    (( cols > 100 )) && cols=100
    whiptail --title "$title" --scrolltext --yes-button "Proceed" --no-button "Cancel" \
      --yesno "$body" "$rows" "$cols"
    return $?
  fi
  printf '%s\n%s\n\nProceed? [Y/n] ' "${C_BOLD}${title}${C_RESET}" "$body"
  local ans; read -r ans
  [[ -z "$ans" || "$ans" =~ ^[Yy] ]]
}

# ui_failure_menu "<step title>" → echoes retry|skip|abort
ui_failure_menu() {
  local title="$1" tail_text
  tail_text="$(tail -n 15 "$NI_LOG_FILE" 2>/dev/null || true)"
  if ! ui_interactive; then echo abort; return; fi
  if ui_has_whiptail; then
    whiptail --title "Step failed: $title" --menu \
      "Last log lines:\n\n${tail_text}\n\nFull log: ${NI_LOG_FILE}" 30 100 3 \
      retry "Try this step again" \
      skip  "Skip this step and continue" \
      abort "Stop the installer (re-run later with --resume)" 3>&1 1>&2 2>&3 || echo abort
    return
  fi
  printf '%s\n\n[r]etry / [s]kip / [a]bort? ' "$tail_text" >&2
  local ans; read -r ans
  case "$ans" in r*|R*) echo retry ;; s*|S*) echo skip ;; *) echo abort ;; esac
}

# ui_prompt "<question>" [secret]  → echoes the answer (interactive only)
ui_prompt() {
  local q="$1" secret="${2:-}" ans
  if ui_has_whiptail; then
    if [[ -n "$secret" ]]; then
      ans=$(whiptail --passwordbox "$q" 10 90 3>&1 1>&2 2>&3) || return 1
    else
      ans=$(whiptail --inputbox "$q" 10 90 3>&1 1>&2 2>&3) || return 1
    fi
  else
    printf '%s ' "$q" >&2
    if [[ -n "$secret" ]]; then read -rs ans; echo >&2; else read -r ans; fi
  fi
  printf '%s' "$ans"
}

# run_logged <cmd...> — runs a command, appending stdout/stderr to the log file.
# On a terminal it shows a live one-line ticker (elapsed time + last log line) so long
# apt/npm runs never look frozen.
run_logged() {
  if [[ -n "${NI_DRY_RUN:-}" ]]; then log_dim "[dry-run] $*"; return 0; fi
  _log_to_file "RUN   $*"
  if [[ ! -t 1 ]]; then
    "$@" >>"$NI_LOG_FILE" 2>&1
    return
  fi
  "$@" >>"$NI_LOG_FILE" 2>&1 &
  local pid=$! rc=0 start=$SECONDS cols last
  cols=$(( $(tput cols 2>/dev/null || echo 100) - 16 ))
  (( cols < 20 )) && cols=20
  while kill -0 "$pid" 2>/dev/null; do
    last="$(tail -n 1 "$NI_LOG_FILE" 2>/dev/null | tr -d '\r' | cut -c1-"$cols")"
    printf '\r\e[K%s    %4ss  %s%s' "$C_DIM" "$(( SECONDS - start ))" "$last" "$C_RESET"
    sleep 1
  done
  wait "$pid" || rc=$?
  printf '\r\e[K'
  return "$rc"
}

# as_user <cmd string> — run a login shell command as the target user.
as_user() {
  if [[ -n "${NI_DRY_RUN:-}" ]]; then log_dim "[dry-run] (as ${NI_USER}) $*"; return 0; fi
  _log_to_file "RUN   (as ${NI_USER}) $*"
  sudo -u "$NI_USER" -H bash -lc "$*" >>"$NI_LOG_FILE" 2>&1
}

# as_user_capture <cmd string> — like as_user but returns stdout to caller.
as_user_capture() {
  sudo -u "$NI_USER" -H bash -lc "$*" 2>>"$NI_LOG_FILE"
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# join_by <sep> <items...> — "a, b, c"
join_by() {
  local sep="$1" out=""; shift
  local x
  for x in "$@"; do out+="${out:+$sep}$x"; done
  printf '%s' "$out"
}

# ───── bin/nicode (embedded) ─────
nicode_cli_source() {
cat <<'NICODE_CLI_EOF'
#!/usr/bin/env bash
# nicode — manage a niCode host. Installed to /usr/local/bin/nicode by the installer.
# The app also calls `nicode status --json` and `nicode token add <name> --json` over SSH
# to pair with an already-installed server (see docs/04 "Connect to an existing server").
set -euo pipefail

INSTALLER=/usr/local/lib/nicode/nicode-install.sh
SETTINGS=/etc/nicode/install.env
PROFILE=/var/lib/nicode/profile.env
STATUS=/var/lib/nicode/public/status.json
NICODE_CLI_VERSION=2

# shellcheck disable=SC1090
[[ -r "$SETTINGS" ]] && source "$SETTINGS"
# shellcheck disable=SC1090
[[ -r "$PROFILE" ]] && source "$PROFILE"
NI_USER="${NI_USER:-${NICODE_USER:-dev}}"
NI_USER_HOME="${NI_USER_HOME:-$(getent passwd "$NI_USER" 2>/dev/null | cut -d: -f6 || echo "/home/$NI_USER")}"
CONFIG="$NI_USER_HOME/.config/nicode/config.json"
ENVFILE="$NI_USER_HOME/.config/nicode/env"

ORIG_ARGS=("$@")
need_root() { [[ $EUID -eq 0 ]] || exec sudo "$0" "${ORIG_ARGS[@]}"; }
as_user()   { if [[ "$(id -un)" == "$NI_USER" ]]; then bash -lc "$1"; else sudo -u "$NI_USER" -H bash -lc "$1"; fi; }
cfg()       { jq -r "$1 // empty" "$CONFIG" 2>/dev/null || true; }
have_service() { [[ -f /etc/systemd/system/nicode.service ]]; }
has_flag()  { local f="$1"; shift; local a; for a in "$@"; do [[ "$a" == "$f" ]] && return 0; done; return 1; }

claude_logged_in() {
  [[ -s "$NI_USER_HOME/.claude/.credentials.json" ]] || grep -qs '^CLAUDE_CODE_OAUTH_TOKEN=.' "$ENVFILE"
}

set_status_state() {
  [[ -w "$STATUS" || $EUID -eq 0 ]] || return 0
  local tmp; tmp="$(mktemp)"
  jq --arg s "$1" '.state=$s | .updatedAt=(now|todate) | .error=null' "$STATUS" >"$tmp" && cat "$tmp" >"$STATUS"
  rm -f "$tmp"
}

endpoint() {  # prints "<scheme> <host> <port>"
  case "$(cfg .transport)" in
    https) echo "https $(cfg .publicHost) 443" ;;
    *)     echo "http $(cfg .publicHost) $(cfg .port)" ;;
  esac
}

pairing_uri() {
  local scheme host port
  read -r scheme host port < <(endpoint)
  printf 'nicode://pair?h=%s&p=%s&s=%s&t=%s&n=%s' "$host" "$port" "$scheme" "$1" "$(hostname)"
}

cmd_pair_print() {
  local uri; uri="$(pairing_uri "$1")"
  echo "Scan in the niCode app (Add server → Scan QR):"
  command -v qrencode >/dev/null && qrencode -t ansiutf8 "$uri"
  echo "Or enter manually:"
  printf '  host:  %s\n  token: %s\n  uri:   %s\n' "$(cfg .publicHost)" "$1" "$uri"
}

# Writes the config atomically, keeping owner + mode 600.
config_update() {  # config_update <jq filter> [jq args...]
  local filter="$1"; shift
  local tmp; tmp="$(mktemp "$CONFIG.XXXX")"
  jq "$@" "$filter" "$CONFIG" >"$tmp"
  chmod 600 "$tmp"; chown "$NI_USER:" "$tmp"; mv -f "$tmp" "$CONFIG"
}

reload_daemon() { have_service && systemctl reload-or-restart nicode >/dev/null 2>&1 || true; }

# ── Tokens: one per paired device ───────────────────────────────────────────
cmd_token_add() {
  need_root
  local name="${1:-device}" token hash id
  [[ "$name" == --json ]] && name=device
  [[ -f "$CONFIG" ]] || { echo "niCode daemon not installed (no $CONFIG)" >&2; exit 1; }
  token="$(openssl rand -hex 32)"
  hash="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
  id="d_$(openssl rand -hex 4)"
  config_update '.tokens = ((.tokens // []) + [{id: $id, name: $n, sha256: $h, createdAt: (now|todate)}])' \
    --arg id "$id" --arg n "$name" --arg h "$hash"
  reload_daemon
  if has_flag --json "$@"; then
    local scheme host port
    read -r scheme host port < <(endpoint)
    jq -n --arg id "$id" --arg name "$name" --arg token "$token" --arg scheme "$scheme" \
      --arg host "$host" --argjson port "$port" --arg uri "$(pairing_uri "$token")" \
      '{id:$id, name:$name, token:$token, scheme:$scheme, host:$host, port:$port, uri:$uri}'
  else
    echo "Added device \"$name\" ($id)."
    cmd_pair_print "$token"
  fi
}

cmd_token_list() {
  need_root
  if has_flag --json "$@"; then jq '[.tokens // [] | .[] | {id, name, createdAt}]' "$CONFIG"; return; fi
  jq -r '(.tokens // [])[] | "\(.id)\t\(.createdAt)\t\(.name)"' "$CONFIG" | column -t -s $'\t'
}

cmd_token_revoke() {
  need_root
  local key="${1:?usage: nicode token revoke <id|name>}"
  config_update '.tokens = [(.tokens // [])[] | select(.id != $k and .name != $k)]' --arg k "$key"
  reload_daemon
  echo "Revoked $key. That device must pair again."
}

cmd_token_rotate() {  # revoke everything, issue one new token
  need_root
  config_update '.tokens = []'
  echo "All device tokens revoked."
  cmd_token_add "${1:-device}"
}

# ── Status ──────────────────────────────────────────────────────────────────
cmd_status() {
  local state="unknown" svc="not-installed" installed=false
  [[ -r "$STATUS" ]] && state="$(jq -r .state "$STATUS" 2>/dev/null || echo unknown)"
  [[ -f "$CONFIG" ]] && installed=true
  have_service && svc="$(systemctl is-active nicode 2>/dev/null || true)"
  local claude_ver claude_ok=false gh_ok=false
  claude_ver="$(as_user 'claude --version 2>/dev/null' | head -n1 || true)"
  claude_logged_in && claude_ok=true
  as_user 'gh auth status >/dev/null 2>&1' && gh_ok=true

  if has_flag --json "$@"; then
    local scheme="" host="" port=0
    [[ "$installed" == true ]] && read -r scheme host port < <(endpoint)
    jq -n --argjson cli "$NICODE_CLI_VERSION" --argjson installed "$installed" --arg state "$state" \
      --arg daemon "$svc" --arg scheme "$scheme" --arg host "$host" --argjson port "${port:-0}" \
      --arg transport "$(cfg .transport)" --arg user "$NI_USER" --arg projectsRoot "$(cfg .projectsRoot)" \
      --arg claudeVersion "$claude_ver" --argjson claude "$claude_ok" --argjson github "$gh_ok" \
      '{cli:$cli, installed:$installed, state:$state, daemon:$daemon, scheme:$scheme, host:$host, port:$port,
        transport:$transport, user:$user, projectsRoot:$projectsRoot,
        claudeVersion:$claudeVersion, claudeLoggedIn:$claude, githubLoggedIn:$github}'
    return
  fi
  printf 'State:     %s\n' "$state"
  printf 'Daemon:    %s (127.0.0.1:%s)\n' "$svc" "$(cfg .port)"
  printf 'Endpoint:  %s (%s)\n' "$(cfg .publicHost)" "$(cfg .transport)"
  printf 'User:      %s   projects: %s\n' "$NI_USER" "$(cfg .projectsRoot)"
  printf 'Claude:    %s\n' "${claude_ver:-not installed}"
  if [[ "$claude_ok" == true ]]; then echo 'Login:     Claude ✓'; else echo 'Login:     Claude ✗  (run: nicode login)'; fi
  if [[ "$gh_ok" == true ]]; then echo 'GitHub:    ✓'; else echo 'GitHub:    ✗  (log in from the app, or: gh auth login)'; fi
  printf 'Devices:   %s paired\n' "$(jq '(.tokens // []) | length' "$CONFIG" 2>/dev/null || echo 0)"
}

cmd_motd() {
  local state; state="$(jq -r .state "$STATUS" 2>/dev/null || echo unknown)"
  case "$state" in
    ready)              echo "niCode: ready — $(cfg .publicHost)" ;;
    needs_claude_login) echo "niCode: Claude login pending — open the app or run: nicode login" ;;
    base_ready)         echo "niCode: base tools installed (no daemon yet) — run: sudo nicode update" ;;
    *)                  echo "niCode: $state — run: nicode status" ;;
  esac
}

cmd_login() {
  if claude_logged_in && ! has_flag --force "$@"; then
    echo "Claude is already logged in for $NI_USER (use --force to log in again)."; return
  fi
  echo "Step 1/2: Claude will print a URL. Open it on any device, approve, and paste the code back here."
  as_user 'claude setup-token' || true
  echo
  local token
  read -rsp "Step 2/2: paste the long-lived token it printed (sk-ant-oat…): " token; echo
  [[ "$token" == sk-ant-* ]] || { echo "That doesn't look like a Claude OAuth token." >&2; exit 1; }
  as_user "umask 077; mkdir -p '$(dirname "$ENVFILE")'; touch '$ENVFILE'; sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' '$ENVFILE'; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' '$token' >> '$ENVFILE'"
  echo "Verifying…"
  if as_user "CLAUDE_CODE_OAUTH_TOKEN='$token' claude -p 'Reply with just OK' 2>&1" | grep -qi ok; then
    echo "Claude login OK."
    have_service && sudo systemctl restart nicode
    set_status_state ready || true
  else
    echo "Verification failed — check the token and try again." >&2; exit 1
  fi
}

cmd_update() {
  need_root
  if [[ -n "${NICODE_INSTALLER_URL:-}" ]] && ! grep -q '^exec bash' "$INSTALLER" 2>/dev/null; then
    echo "Fetching latest installer…"
    curl -fsSL "$NICODE_INSTALLER_URL" -o "$INSTALLER.new" && mv -f "$INSTALLER.new" "$INSTALLER" && chmod 755 "$INSTALLER"
  fi
  echo "Updating Claude Code…"
  as_user 'claude update' || true
  bash "$INSTALLER" --unattended --stage full --redo daemon,finish
}

cmd_uninstall() {
  need_root
  read -rp "Remove the niCode daemon, Caddy site and installer state? Projects, Claude and the user are kept. [y/N] " a
  [[ "$a" =~ ^[Yy] ]] || exit 0
  if have_service; then systemctl disable --now nicode || true; rm -f /etc/systemd/system/nicode.service; systemctl daemon-reload; fi
  if [[ -f /etc/caddy/nicode.caddy ]]; then
    rm -f /etc/caddy/nicode.caddy
    sed -i '\|import /etc/caddy/nicode.caddy|d' /etc/caddy/Caddyfile
    systemctl reload caddy || true
  fi
  if [[ -f /etc/nginx/sites-available/nicode.conf ]]; then
    rm -f /etc/nginx/sites-enabled/nicode.conf /etc/nginx/sites-available/nicode.conf
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
  rm -rf /opt/nicode /var/lib/nicode /etc/nicode /usr/local/lib/nicode /etc/update-motd.d/99-nicode
  rm -f /usr/local/bin/nicode "$CONFIG"
  echo "niCode removed."
}

usage() {
  cat <<'EOF'
nicode — manage this niCode host

  status [--json]            Daemon, endpoint, Claude/GitHub login state, paired devices
  pair [name]                Pair a new phone: new device token + QR (other devices keep working)
  token add <name> [--json]  Same as pair; --json is what the app reads over SSH
  token list [--json]        Paired devices
  token revoke <id|name>     Unpair one device
  token rotate               Revoke ALL devices and issue one new token
  login [--force]            Log Claude Code in (skipped if already logged in)
  doctor                     Re-detect the host and show what the installer would change
  logs [-f]                  Daemon logs
  restart                    Restart the daemon
  update                     Update installer, Claude Code and daemon
  uninstall                  Remove niCode (keeps projects, user and Claude)
EOF
}

case "${1:-help}" in
  status)    shift; cmd_status "$@" ;;
  motd)      cmd_motd ;;
  doctor)    need_root; bash "$INSTALLER" --dry-run ;;
  login)     shift; cmd_login "$@" ;;
  pair)      shift; cmd_token_add "${1:-$(hostname)-device}" ;;
  token)
    sub="${2:-}"; shift 2 || true
    case "$sub" in
      add)    cmd_token_add "$@" ;;
      list)   cmd_token_list "$@" ;;
      revoke) cmd_token_revoke "$@" ;;
      rotate) cmd_token_rotate "$@" ;;
      *)      usage; exit 2 ;;
    esac ;;
  _pair-print) cmd_pair_print "$2" ;;
  logs)      shift; journalctl -u nicode --no-pager -n 200 "$@" ;;
  restart)   need_root; systemctl restart nicode; echo restarted ;;
  update)    cmd_update ;;
  uninstall) cmd_uninstall ;;
  version)   echo "nicode CLI v$NICODE_CLI_VERSION" ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
NICODE_CLI_EOF
}

# ───── install.sh ─────
# niCode server installer — turns a fresh Ubuntu/Debian host into a niCode host.
# Detects everything itself; the only interactive parts (Claude/GitHub login) happen in the app.
#
#   sudo bash nicode-install.sh                 # guided: detect → review → install
#   sudo bash nicode-install.sh --dry-run       # show what was detected and what would happen
#   sudo bash nicode-install.sh --unattended --stage full --token <t> --setup-id <id>   # app / cloud-init
#
# Docs: docs/01-INSTALLER.md

set -Eeuo pipefail

NICODE_INSTALLER_VERSION="0.1.0"

if [[ -z "${NICODE_BUNDLED:-}" ]]; then
  NI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for _f in "$NI_SCRIPT_DIR"/lib/*.sh; do
    # shellcheck disable=SC1090
    source "$_f"
  done
  unset _f
fi

usage() {
  cat <<'EOF'
niCode installer

Options
  --dry-run              Detect and print the plan; change nothing (no root needed)
  --unattended           No prompts; accept the detected plan (for the app / cloud-init)
  -y, --yes              Skip the review screen but still show progress
  --stage base|full      base = tools only; full = + niCode daemon (default: full)
  --transport T          https | tailscale | local   (default: auto-detected)
  --domain NAME          Use your own domain instead of <ip>.sslip.io (A record must point here)
  --token HEX            Daemon token chosen by the app (else generated and shown as a QR)
  --setup-id ID          Id that guards /setup/status (else generated)
  --user NAME            Developer user (default: auto-detected — reuses whoever is already
                         logged in to Claude, including root — else "dev")
  --no-root              Never reuse root; create/use a separate developer user
  --projects-root DIR    Folder holding your repos (default: auto-detected, else ~/projects)
  --host-mode M          fresh | existing (default: auto). existing = add niCode only; no apt upgrade,
                         SSH/firewall/swap/system-Node changes
  --device-name NAME     Name for the device token supplied with --token (shown in `nicode token list`)
  --port N               Daemon port on localhost (default: first free from 7878)
  --repo URL --ref REF   Where to fetch niCode from (default: settings / built-in)
  --source-dir DIR       Use a local niCode checkout instead of cloning (development)
  --ts-authkey KEY       Tailscale auth key (transport=tailscale, unattended)
  --git-name / --git-email   Git identity, if you want it set now
  --claude-version V     Pin Claude Code version
  --config FILE          Source NICODE_* variables from FILE (cloud-init answers file)
  --only a,b  --skip a,b  --redo a,b   Step selection (ids: system user harden edge node claude git daemon finish)
  --resume               Continue a previous run (default behaviour; finished steps are skipped)
  --force                Continue on an unsupported OS
  -h, --help
EOF
}

# ── Arguments ────────────────────────────────────────────────────────────────
declare -A NI_ARGS=()
NI_CONFIG_FILE=""
while (($#)); do
  case "$1" in
    --dry-run)       NI_DRY_RUN=1 ;;
    --unattended)    NI_UNATTENDED=1; NI_ASSUME_YES=1 ;;
    -y|--yes)        NI_ASSUME_YES=1 ;;
    --resume)        : ;;
    --force)         NI_ARGS[NICODE_FORCE]=1 ;;
    --stage)         NI_ARGS[NICODE_STAGE]="$2"; shift ;;
    --transport)     NI_ARGS[NICODE_TRANSPORT]="$2"; shift ;;
    --domain)        NI_ARGS[NICODE_DOMAIN]="$2"; shift ;;
    --token)         NI_ARGS[NICODE_TOKEN]="$2"; shift ;;
    --setup-id)      NI_ARGS[NICODE_SETUP_ID]="$2"; shift ;;
    --user)          NI_ARGS[NICODE_USER]="$2"; shift ;;
    --no-root)       NI_ARGS[NICODE_NO_ROOT]=1 ;;
    --projects-root) NI_ARGS[NICODE_PROJECTS_ROOT]="$2"; shift ;;
    --device-name)   NI_ARGS[NICODE_DEVICE_NAME]="$2"; shift ;;
    --host-mode)     NI_ARGS[NICODE_HOST_MODE]="$2"; shift ;;
    --port)          NI_ARGS[NICODE_PORT]="$2"; shift ;;
    --repo)          NI_ARGS[NICODE_REPO]="$2"; shift ;;
    --ref)           NI_ARGS[NICODE_REF]="$2"; shift ;;
    --source-dir)    NI_ARGS[NICODE_SOURCE_DIR]="$2"; shift ;;
    --ts-authkey)    NI_ARGS[NICODE_TS_AUTHKEY]="$2"; shift ;;
    --git-name)      NI_ARGS[NICODE_GIT_NAME]="$2"; shift ;;
    --git-email)     NI_ARGS[NICODE_GIT_EMAIL]="$2"; shift ;;
    --claude-version) NI_ARGS[NICODE_CLAUDE_VERSION]="$2"; shift ;;
    --config)        NI_CONFIG_FILE="$2"; shift ;;
    --only)          NI_ONLY="$2"; shift ;;
    --skip)          NI_SKIP="$2"; shift ;;
    --redo)          NI_REDO="$2"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# Precedence: built-in defaults < saved settings < --config file < environment < flags.
_env_vars="$(compgen -v NICODE_ 2>/dev/null || true)"
_env_snapshot=""
# shellcheck disable=SC2086  # word-split the variable list
[[ -n "$_env_vars" ]] && _env_snapshot="$(declare -p $_env_vars 2>/dev/null || true)"
unset _env_vars
settings_load
if [[ -n "$NI_CONFIG_FILE" ]]; then
  [[ -r "$NI_CONFIG_FILE" ]] || { echo "Cannot read --config $NI_CONFIG_FILE" >&2; exit 2; }
  # shellcheck disable=SC1090
  source "$NI_CONFIG_FILE"
fi
eval "$_env_snapshot"
for _k in "${!NI_ARGS[@]}"; do printf -v "$_k" '%s' "${NI_ARGS[$_k]}"; done
unset _k _env_snapshot

: "${NICODE_REPO:=https://github.com/NisalJunaid/NiCode}"
: "${NICODE_REF:=main}"
: "${NICODE_STAGE:=full}"
if [[ -z "${NICODE_INSTALLER_URL:-}" && "$NICODE_REPO" == https://github.com/* ]]; then
  NICODE_INSTALLER_URL="https://raw.githubusercontent.com/${NICODE_REPO#https://github.com/}/${NICODE_REF}/dist/nicode-install.sh"
fi
[[ "$NICODE_STAGE" == base || "$NICODE_STAGE" == full ]] || { echo "--stage must be base or full" >&2; exit 2; }

# ── Environment ──────────────────────────────────────────────────────────────
NI_TMP="$(mktemp -d)"
trap 'rm -rf "$NI_TMP"' EXIT

if [[ -n "${NI_DRY_RUN:-}" ]]; then
  NI_PROFILE_FILE="$NI_TMP/profile.env"
  NI_LOG_FILE="$NI_TMP/install.log"
else
  [[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0 $*" >&2; exit 1; }
  NI_PROFILE_FILE="$NI_STATE_DIR/profile.env"
fi

# Installs /usr/local/bin/nicode and a stable copy of this installer for `nicode update/doctor`.
install_cli() {
  install -d -m 755 /usr/local/lib/nicode
  if declare -f nicode_cli_source >/dev/null; then
    nicode_cli_source >/usr/local/bin/nicode
    if [[ -f "${BASH_SOURCE[0]:-}" ]]; then
      cp -f "${BASH_SOURCE[0]}" /usr/local/lib/nicode/nicode-install.sh
    elif [[ -n "${NICODE_INSTALLER_URL:-}" ]]; then
      curl -fsSL "$NICODE_INSTALLER_URL" -o /usr/local/lib/nicode/nicode-install.sh || true
    fi
  else
    # Running from a source checkout: point at it so edits are picked up (development).
    cp -f "$NI_SCRIPT_DIR/bin/nicode" /usr/local/bin/nicode
    printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$NI_SCRIPT_DIR/install.sh" >/usr/local/lib/nicode/nicode-install.sh
  fi
  chmod 755 /usr/local/bin/nicode /usr/local/lib/nicode/nicode-install.sh 2>/dev/null || true
}

# ── Run ──────────────────────────────────────────────────────────────────────
state_init            # creates /var/lib/nicode before anything writes there
: >"$NI_PROFILE_FILE"
[[ -z "${NI_DRY_RUN:-}" ]] && install_cli
status_init

printf '%sniCode installer %s%s\n' "$C_BOLD" "$NICODE_INSTALLER_VERSION" "$C_RESET"
run_step detect
profile_reload
: "${NICODE_TRANSPORT:=https}"

if [[ -n "${NI_DRY_RUN:-}" ]]; then
  echo; detect_plan_text; echo
  echo "(dry run — nothing was changed)"
  exit 0
fi

if ! ui_review "niCode — here's what I found and will do" "$(detect_plan_text)"; then
  echo "Cancelled. Nothing was changed apart from detection."
  status_state error "cancelled by user"
  exit 0
fi

: "${NICODE_SETUP_ID:=$(openssl rand -hex 16 2>/dev/null || head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
NICODE_USER="$NI_USER"
NICODE_PORT="$NI_PORT"
NICODE_PROJECTS_ROOT="$NI_PROJECTS_ROOT"
settings_save

for _s in $(steps_selected); do
  [[ "$_s" == detect ]] && continue
  run_step "$_s"
  profile_reload
done

NI_FINAL_STATE="$(cat "$NI_TMP/final_state" 2>/dev/null || echo base_ready)"
status_state "$NI_FINAL_STATE"
finish_summary "$NI_FINAL_STATE"

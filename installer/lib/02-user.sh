# shellcheck shell=bash
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

  step_detail "$(IFS=';'; echo "${notes[*]}")"
}

# shellcheck shell=bash
# Step 3 — SSH lockdown, firewall, fail2ban. Never locks you out: password auth is only
# disabled when a key-based login path is confirmed to exist.

step_harden() {
  if [[ "$NI_PLATFORM" == wsl || "$NI_PLATFORM" == container ]]; then
    step_detail "not applicable on $NI_PLATFORM"; return 2
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
  ufw --force enable >>"$NI_LOG_FILE" 2>&1
  profile_set NI_UFW_ACTIVE 1
  notes+=("ufw on")

  systemctl enable --now fail2ban >>"$NI_LOG_FILE" 2>&1 && notes+=("fail2ban on")

  step_detail "$(IFS=';'; echo "${notes[*]}")"
}

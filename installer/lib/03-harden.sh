# shellcheck shell=bash
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

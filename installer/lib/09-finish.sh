# shellcheck shell=bash
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

  # Remove the cloud-init answers file once used (it holds only public values now, but keep /root tidy).
  if [[ -n "${NI_CONFIG_FILE:-}" && -f "$NI_CONFIG_FILE" ]] && grep -q '^NICODE_' "$NI_CONFIG_FILE"; then
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
  local cfg="$NI_USER_HOME/.config/nicode/config.json" phones=0
  if [[ "$NI_DAEMON_INSTALLED" == 1 && -f "$cfg" ]]; then
    phones="$(jq '[(.devices // [])[] | select(.publicKey)] | length' "$cfg" 2>/dev/null || echo 0)"
    echo
    if (( phones == 0 )); then
      # No phone yet: show a one-time pairing code (single use, expires in 10 minutes).
      /usr/local/bin/nicode pair "phone" || true
    else
      printf '  Paired phones: %s. Add another with: nicode pair\n' "$phones"
    fi
  fi
  case "$state" in
    base_ready)         printf '\n  Next: once server/ is published, run  sudo nicode update  (installs the daemon).\n' ;;
    needs_claude_login) printf '\n  Next: open the niCode app to log in to Claude — or run  nicode login  here.\n' ;;
  esac
  echo
}

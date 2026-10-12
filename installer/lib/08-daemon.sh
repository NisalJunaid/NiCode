# shellcheck shell=bash
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

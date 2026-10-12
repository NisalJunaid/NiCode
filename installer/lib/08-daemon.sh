# shellcheck shell=bash
# Step 8 — fetch + build server/, write config, run as a systemd service.

NI_APP_DIR="${NI_APP_DIR:-/opt/nicode}"

step_daemon() {
  local src cfg_dir cfg bind

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

  # 3. Config. Devices are phones (hardware public keys) or short-lived browser tokens.
  #    Existing phones and unexpired tokens are kept; legacy permanent tokens are dropped.
  #    A droplet created by the app passes the phone's PUBLIC key (NICODE_DEVICE_PUBKEY=ALG:BASE64),
  #    so no secret ever goes through cloud-init. Otherwise pair with `nicode pair` (shown at the end).
  cfg_dir="$NI_USER_HOME/.config/nicode"
  cfg="$cfg_dir/config.json"
  local devices='[]' codes='[]'
  if [[ -f "$cfg" ]]; then
    devices="$(jq -c '(.devices // .tokens // []) | map(select(.publicKey != null or .expiresAt != null))' "$cfg")"
    codes="$(jq -c '.pairingCodes // []' "$cfg")"
  fi
  if [[ -n "${NICODE_DEVICE_PUBKEY:-}" ]]; then
    local alg="${NICODE_DEVICE_PUBKEY%%:*}" pub="${NICODE_DEVICE_PUBKEY#*:}"
    case "$alg" in RS256|ES256|Ed25519) ;; *) step_detail "NICODE_DEVICE_PUBKEY must be ALG:BASE64 (RS256|ES256|Ed25519)"; return 1 ;; esac
    devices="$(jq -c --arg a "$alg" --arg k "$pub" --arg n "${NICODE_DEVICE_NAME:-phone}" --arg id "d_$(printf '%s' "$pub" | sha256sum | cut -c1-8)" \
      'if any(.[]; .publicKey == $k) then . else . + [{id: $id, name: $n, alg: $a, publicKey: $k, createdAt: (now | todate)}] end' <<<"$devices")"
  fi
  if [[ -n "${NICODE_TOKEN:-}" ]]; then
    log_warn "NICODE_TOKEN/--token is no longer supported (permanent tokens were removed). Pair with: nicode pair"
  fi

  case "$NICODE_TRANSPORT" in
    https)     bind=127.0.0.1 ;;
    tailscale) bind="$NI_PUBLIC_HOST" ;;
    local)     bind=0.0.0.0 ;;
  esac
  tmpl_daemon_config "$bind" "$devices" "$src" "$codes" >"$cfg.tmp"
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

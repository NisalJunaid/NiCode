# shellcheck shell=bash
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

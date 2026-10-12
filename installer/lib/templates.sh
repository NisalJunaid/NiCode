# shellcheck shell=bash
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

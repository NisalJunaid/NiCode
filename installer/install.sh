#!/usr/bin/env bash
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
      # `nicode update` runs the installer from this very path; don't copy a file onto itself.
      if [[ "$(realpath "${BASH_SOURCE[0]}")" != "$(realpath /usr/local/lib/nicode/nicode-install.sh 2>/dev/null)" ]]; then
        cp -f "${BASH_SOURCE[0]}" /usr/local/lib/nicode/nicode-install.sh
      fi
    elif [[ -n "${NICODE_INSTALLER_URL:-}" ]]; then
      curl -fsSL -H "Cache-Control: no-cache" "${NICODE_INSTALLER_URL}?t=$(date +%s)" -o /usr/local/lib/nicode/nicode-install.sh || true
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

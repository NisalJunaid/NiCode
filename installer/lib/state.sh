# shellcheck shell=bash
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
  [node]="Node.js 22"
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

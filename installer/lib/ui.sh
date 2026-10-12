# shellcheck shell=bash
# UI helpers: logging, whiptail wrappers with plain-text fallback.

NI_LOG_FILE="${NI_LOG_FILE:-/var/log/nicode-install.log}"

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'
  C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_BLUE=$'\e[34m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

_log_to_file() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$NI_LOG_FILE" 2>/dev/null || true
}

log_info()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; _log_to_file "INFO  $*"; }
log_ok()    { printf '%s ✓%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; _log_to_file "OK    $*"; }
log_warn()  { printf '%s !%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; _log_to_file "WARN  $*"; }
log_error() { printf '%s ✗%s  %s\n' "$C_RED" "$C_RESET" "$*" >&2; _log_to_file "ERROR $*"; }
log_dim()   { printf '%s    %s%s\n' "$C_DIM" "$*" "$C_RESET"; _log_to_file "      $*"; }

die() {
  log_error "$*"
  if declare -f status_state >/dev/null; then status_state error "$*"; fi
  exit 1
}

# Interactive = a human is at a terminal and we were not told to run unattended.
ui_interactive() {
  [[ -z "${NI_UNATTENDED:-}" && -t 0 && -t 1 ]]
}

ui_has_whiptail() {
  command -v whiptail >/dev/null 2>&1
}

# ui_review "<title>" "<body>"  → returns 0 to proceed, 1 to cancel.
ui_review() {
  local title="$1" body="$2"
  if [[ -n "${NI_ASSUME_YES:-}" ]] || ! ui_interactive; then
    printf '%s\n%s\n' "${C_BOLD}${title}${C_RESET}" "$body"
    return 0
  fi
  if ui_has_whiptail; then
    local rows cols
    rows=$(( $(tput lines 2>/dev/null || echo 30) - 4 ))
    cols=$(( $(tput cols 2>/dev/null || echo 100) - 6 ))
    (( cols > 100 )) && cols=100
    whiptail --title "$title" --scrolltext --yes-button "Proceed" --no-button "Cancel" \
      --yesno "$body" "$rows" "$cols"
    return $?
  fi
  printf '%s\n%s\n\nProceed? [Y/n] ' "${C_BOLD}${title}${C_RESET}" "$body"
  local ans; read -r ans
  [[ -z "$ans" || "$ans" =~ ^[Yy] ]]
}

# ui_failure_menu "<step title>" → echoes retry|skip|abort
ui_failure_menu() {
  local title="$1" tail_text
  tail_text="$(tail -n 15 "$NI_LOG_FILE" 2>/dev/null || true)"
  if ! ui_interactive; then echo abort; return; fi
  if ui_has_whiptail; then
    whiptail --title "Step failed: $title" --menu \
      "Last log lines:\n\n${tail_text}\n\nFull log: ${NI_LOG_FILE}" 30 100 3 \
      retry "Try this step again" \
      skip  "Skip this step and continue" \
      abort "Stop the installer (re-run later with --resume)" 3>&1 1>&2 2>&3 || echo abort
    return
  fi
  printf '%s\n\n[r]etry / [s]kip / [a]bort? ' "$tail_text" >&2
  local ans; read -r ans
  case "$ans" in r*|R*) echo retry ;; s*|S*) echo skip ;; *) echo abort ;; esac
}

# ui_prompt "<question>" [secret]  → echoes the answer (interactive only)
ui_prompt() {
  local q="$1" secret="${2:-}" ans
  if ui_has_whiptail; then
    if [[ -n "$secret" ]]; then
      ans=$(whiptail --passwordbox "$q" 10 90 3>&1 1>&2 2>&3) || return 1
    else
      ans=$(whiptail --inputbox "$q" 10 90 3>&1 1>&2 2>&3) || return 1
    fi
  else
    printf '%s ' "$q" >&2
    if [[ -n "$secret" ]]; then read -rs ans; echo >&2; else read -r ans; fi
  fi
  printf '%s' "$ans"
}

# run_logged <cmd...> — runs a command, appending stdout/stderr to the log file.
# On a terminal it shows a live one-line ticker (elapsed time + last log line) so long
# apt/npm runs never look frozen.
run_logged() {
  if [[ -n "${NI_DRY_RUN:-}" ]]; then log_dim "[dry-run] $*"; return 0; fi
  _log_to_file "RUN   $*"
  if [[ ! -t 1 ]]; then
    "$@" >>"$NI_LOG_FILE" 2>&1
    return
  fi
  "$@" >>"$NI_LOG_FILE" 2>&1 &
  local pid=$! rc=0 start=$SECONDS cols last
  cols=$(( $(tput cols 2>/dev/null || echo 100) - 16 ))
  (( cols < 20 )) && cols=20
  while kill -0 "$pid" 2>/dev/null; do
    last="$(tail -n 1 "$NI_LOG_FILE" 2>/dev/null | tr -d '\r' | cut -c1-"$cols")"
    printf '\r\e[K%s    %4ss  %s%s' "$C_DIM" "$(( SECONDS - start ))" "$last" "$C_RESET"
    sleep 1
  done
  wait "$pid" || rc=$?
  printf '\r\e[K'
  return "$rc"
}

# as_user <cmd string> — run a login shell command as the target user.
as_user() {
  if [[ -n "${NI_DRY_RUN:-}" ]]; then log_dim "[dry-run] (as ${NI_USER}) $*"; return 0; fi
  _log_to_file "RUN   (as ${NI_USER}) $*"
  sudo -u "$NI_USER" -H bash -lc "$*" >>"$NI_LOG_FILE" 2>&1
}

# as_user_capture <cmd string> — like as_user but returns stdout to caller.
as_user_capture() {
  sudo -u "$NI_USER" -H bash -lc "$*" 2>>"$NI_LOG_FILE"
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

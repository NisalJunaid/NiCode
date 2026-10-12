# shellcheck shell=bash
# Writes /var/lib/nicode/public/status.json (schema: SetupStatus in protocol/types.ts).
# Caddy serves it at /setup/status?sid=<setup id> so the app can show live progress.
# Pure bash on purpose: runs before jq is installed.

NI_STATUS_FILE="${NI_STATUS_FILE:-/var/lib/nicode/public/status.json}"
NI_STATUS_STATE="installing"
NI_STATUS_CURRENT=""
NI_STATUS_ERROR=""
declare -A NI_STATUS_STEP=()
declare -A NI_STATUS_DETAIL=()

status_init() {
  local s
  # Keep previous results on --resume so the app doesn't see finished steps flip back to pending.
  if [[ -f "$NI_STATUS_FILE" ]] && command -v jq >/dev/null 2>&1; then
    while IFS=$'\t' read -r id st det; do
      [[ -n "$id" ]] || continue
      NI_STATUS_STEP[$id]="$st"; NI_STATUS_DETAIL[$id]="$det"
    done < <(jq -r '.steps[] | [.id, .status, .detail] | @tsv' "$NI_STATUS_FILE" 2>/dev/null || true)
  fi
  for s in "${NI_ALL_STEPS[@]}"; do
    : "${NI_STATUS_STEP[$s]:=pending}"
    : "${NI_STATUS_DETAIL[$s]:=}"
  done
  NI_STATUS_STATE="installing"
  status_write
}

status_step() {
  local id="$1" st="$2" det="${3:-}"
  NI_STATUS_STEP[$id]="$st"
  NI_STATUS_DETAIL[$id]="$det"
  [[ "$st" == "running" ]] && NI_STATUS_CURRENT="$id"
  status_write
}

status_state() {
  NI_STATUS_STATE="$1"
  NI_STATUS_ERROR="${2:-}"
  [[ "$1" != "error" ]] && NI_STATUS_ERROR=""
  status_write
}

status_write() {
  [[ -n "${NI_DRY_RUN:-}" ]] && return 0
  [[ -d "$(dirname "$NI_STATUS_FILE")" ]] || return 0
  local s steps="" sep="" host="null" err="null" cur="null" tmp
  local -a selected
  mapfile -t selected < <(steps_selected)
  for s in "${selected[@]}"; do
    steps+="${sep}{\"id\":\"$s\",\"title\":\"$(json_escape "${NI_STEP_TITLE[$s]}")\",\"status\":\"${NI_STATUS_STEP[$s]:-pending}\",\"detail\":\"$(json_escape "${NI_STATUS_DETAIL[$s]:-}")\"}"
    sep=","
  done
  [[ -n "${NI_PUBLIC_HOST:-}" ]] && host="\"$(json_escape "$NI_PUBLIC_HOST")\""
  [[ -n "$NI_STATUS_ERROR" ]] && err="\"$(json_escape "$NI_STATUS_ERROR")\""
  [[ -n "$NI_STATUS_CURRENT" ]] && cur="\"$NI_STATUS_CURRENT\""
  tmp="$(mktemp "${NI_STATUS_FILE}.XXXX")"
  printf '{"version":1,"state":"%s","step":%s,"steps":[%s],"host":%s,"transport":"%s","updatedAt":"%s","error":%s}\n' \
    "$NI_STATUS_STATE" "$cur" "$steps" "$host" "${NICODE_TRANSPORT:-https}" "$(date -u +%FT%TZ)" "$err" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$NI_STATUS_FILE"
  # The daemon (running as NI_USER) updates state after Claude login, so it must own the file.
  if [[ -n "${NI_USER:-}" ]] && id "$NI_USER" >/dev/null 2>&1; then
    chown "$NI_USER" "$NI_STATUS_FILE" "$(dirname "$NI_STATUS_FILE")" 2>/dev/null || true
  fi
}

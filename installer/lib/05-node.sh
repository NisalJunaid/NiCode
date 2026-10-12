# shellcheck shell=bash
# Step 5 — Node.js 22 LTS, system-wide so the systemd unit has a stable /usr/bin/node.

step_node() {
  if (( NI_NODE_OK )); then step_detail "v$NI_NODE_VERSION already installed"; return 2; fi
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NI_TMP/nodesource.sh"
  run_logged bash "$NI_TMP/nodesource.sh"
  run_logged "${NI_APT[@]}" install nodejs
  local v; v="$(node -v | tr -d v)"
  profile_set NI_NODE_VERSION "$v"
  profile_set NI_NODE_OK 1
  step_detail "v$v"
}

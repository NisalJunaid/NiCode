# shellcheck shell=bash
# Step 5 — Node.js for the daemon (needs >= 20).
#   An existing Node 20+ is reused as-is.
#   fresh host    : Node 22 LTS system-wide via NodeSource.
#   existing host : a private Node 22 in /opt/nicode/node — the system Node your apps use
#                   (if any) is never replaced or upgraded.

NI_PRIVATE_NODE_DIR=/opt/nicode/node

step_node() {
  if (( NI_NODE_OK )); then
    step_detail "using existing Node v$NI_NODE_VERSION ($NI_NODE_BIN)"
    return 2
  fi
  if [[ "$NI_HOST_MODE" == existing ]]; then
    _node_private
    return
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NI_TMP/nodesource.sh"
  run_logged bash "$NI_TMP/nodesource.sh"
  run_logged "${NI_APT[@]}" install nodejs
  local v; v="$(node -v | tr -d v)"
  profile_set NI_NODE_VERSION "$v"
  profile_set NI_NODE_BIN "$(command -v node)"
  profile_set NI_NODE_OK 1
  step_detail "v$v"
}

_node_private() {
  local arch=x64 ver tarball
  [[ "$NI_ARCH" == arm64 ]] && arch=arm64
  # Latest 22.x from the official index.
  ver="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" | head -n1)"
  [[ -n "$ver" ]] || { step_detail "could not resolve the latest Node 22 build"; return 1; }
  tarball="$NI_TMP/$ver"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$ver" -o "$tarball"
  (cd "$NI_TMP" && curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $ver\$" | sha256sum -c - >>"$NI_LOG_FILE" 2>&1) \
    || { step_detail "Node download failed checksum"; return 1; }
  rm -rf "$NI_PRIVATE_NODE_DIR"
  install -d "$NI_PRIVATE_NODE_DIR"
  tar -xJf "$tarball" -C "$NI_PRIVATE_NODE_DIR" --strip-components=1
  local v; v="$("$NI_PRIVATE_NODE_DIR/bin/node" -v | tr -d v)"
  profile_set NI_NODE_VERSION "$v"
  profile_set NI_NODE_BIN "$NI_PRIVATE_NODE_DIR/bin/node"
  profile_set NI_NODE_OK 1
  step_detail "private Node v$v in $NI_PRIVATE_NODE_DIR (system Node untouched)"
}

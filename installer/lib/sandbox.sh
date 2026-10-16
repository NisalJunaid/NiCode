# shellcheck shell=bash
# The read-only sandbox for Analyze chats (bubblewrap). Part of the daemon step, and
# `nicode sandbox` (installer --sandbox-setup) re-runs it on its own.
#
# Ubuntu 24.04+ blocks unprivileged user namespaces unless an AppArmor profile allows them for
# the program, so bwrap gets a small profile (the same approach Ubuntu uses for other sandboxes).

NI_BWRAP_PROFILE=/etc/apparmor.d/nicode-bwrap

# Can the developer user start a read-only sandbox? (0 = yes)
_bwrap_works() {
  command -v bwrap >/dev/null 2>&1 || return 1
  as_user "bwrap --die-with-parent --unshare-pid --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- true" >>"$NI_LOG_FILE" 2>&1
}

# Installs bubblewrap and, where needed, the AppArmor profile. Prints a one-line summary.
# Never fails: without the sandbox, Analyze still works on development servers (soft mode) and
# the app explains what's missing on production servers.
ensure_analyze_sandbox() {
  local parts=()
  if ! command -v bwrap >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 install --no-install-recommends bubblewrap >>"$NI_LOG_FILE" 2>&1 && parts+=("bubblewrap installed")
    fi
  fi
  if ! command -v bwrap >/dev/null 2>&1; then
    echo "Analyze sandbox unavailable: bubblewrap could not be installed"
    return 0
  fi
  if ! _bwrap_works && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]] && command -v apparmor_parser >/dev/null 2>&1; then
    cat >"$NI_BWRAP_PROFILE" <<EOF
# Managed by niCode: lets bubblewrap create the user namespace for niCode's read-only
# Analyze sandbox (Ubuntu restricts unprivileged user namespaces by default).
abi <abi/4.0>,
include <tunables/global>

profile nicode-bwrap $(command -v bwrap) flags=(unconfined) {
  userns,
  include if exists <local/nicode-bwrap>
}
EOF
    apparmor_parser -r "$NI_BWRAP_PROFILE" >>"$NI_LOG_FILE" 2>&1 && parts+=("AppArmor profile added")
  fi
  if _bwrap_works; then
    parts+=("Analyze sandbox ready")
  else
    parts+=("Analyze sandbox not working (see $NI_LOG_FILE)")
  fi
  join_by ', ' "${parts[@]}"
}

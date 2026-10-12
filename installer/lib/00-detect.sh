# shellcheck shell=bash
# Step 0 — build the host profile (read-only).

step_detect() {
  detect_all
  profile_reload
  if (( ! NI_OS_SUPPORTED )); then
    step_detail "unsupported OS: $NI_OS_ID $NI_OS_VERSION (need Ubuntu 22.04+/Debian 12)"
    [[ -n "${NICODE_FORCE:-}" ]] || return 1
  fi
  if [[ "$NI_ARCH" != amd64 && "$NI_ARCH" != arm64 ]]; then
    step_detail "unsupported CPU architecture: $NI_ARCH"
    return 1
  fi
  if [[ "${NICODE_STAGE}" == full && "$NI_HAS_SYSTEMD" != 1 ]]; then
    log_warn "systemd not running: the daemon will not be installed as a service."
  fi
  step_detail "$NI_PLATFORM, $NI_OS_ID $NI_OS_VERSION $NI_ARCH, ${NI_RAM_MB} MB RAM"
}

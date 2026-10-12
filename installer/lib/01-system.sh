# shellcheck shell=bash
# Step 1 — OS packages, swap, automatic security updates.
# On an "existing" host (see _detect_host_mode) only missing packages are installed:
# no full upgrade, no swap/sysctl changes, no auto-update policy changes.

# Waits up to 10 min for cloud-init / unattended-upgrades to release the dpkg lock.
NI_APT=(apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

step_system() {
  export DEBIAN_FRONTEND=noninteractive
  # Ubuntu 22.04's needrestart otherwise asks which services to restart (hangs unattended runs)
  # or restarts them itself. List only — never restart someone's services.
  export NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
  local done_parts=()

  # An earlier interrupted apt/dpkg run leaves packages half-configured; apt then refuses to
  # install anything. Finishing it can restart services, so on an existing server we stop and
  # let the owner run it; on a fresh host it's safe to finish automatically.
  if [[ -n "$(dpkg --audit 2>/dev/null)" ]] || compgen -G '/var/lib/dpkg/updates/[0-9]*' >/dev/null; then
    if [[ "$NI_HOST_MODE" == existing ]]; then
      step_detail "dpkg has an unfinished earlier run. Fix it first: sudo NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive dpkg --configure -a  (then re-run the installer)"
      return 1
    fi
    run_logged dpkg --configure -a
  fi

  run_logged "${NI_APT[@]}" update

  if [[ "$NI_HOST_MODE" == fresh ]]; then
    run_logged "${NI_APT[@]}" upgrade
    done_parts+=("upgraded")
  fi

  if [[ -n "$NI_MISSING_PKGS" ]]; then
    # shellcheck disable=SC2086  # intentional word splitting of the package list
    run_logged "${NI_APT[@]}" install --no-install-recommends $NI_MISSING_PKGS
    done_parts+=("installed: $NI_MISSING_PKGS")
    profile_set NI_MISSING_PKGS ""
  fi

  # Debian/Ubuntu ship fd as `fdfind`.
  if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd
  fi

  if [[ "$NI_HOST_MODE" == fresh ]] && (( NI_SWAP_PLAN_MB > 0 )) && ! swapon --show=NAME --noheadings | grep -q .; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l "${NI_SWAP_PLAN_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$NI_SWAP_PLAN_MB" status=none
      chmod 600 /swapfile
      mkswap /swapfile >>"$NI_LOG_FILE" 2>&1
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    echo 'vm.swappiness=10' >/etc/sysctl.d/90-nicode-swap.conf
    sysctl -q -p /etc/sysctl.d/90-nicode-swap.conf || true
    done_parts+=("${NI_SWAP_PLAN_MB} MB swap")
    profile_set NI_SWAP_PLAN_MB 0
  fi

  if [[ "$NI_HOST_MODE" == fresh && "$NI_PLATFORM" != wsl && "$NI_PLATFORM" != container ]]; then
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  fi

  (( ${#done_parts[@]} )) || done_parts+=("nothing to change")
  step_detail "$(IFS=';'; echo "${done_parts[*]}")"
}

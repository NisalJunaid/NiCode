# shellcheck shell=bash
# Step 7 — GitHub CLI + sane git defaults. GitHub login happens from the app (device flow).

step_git() {
  local notes=()
  if (( ! NI_GH_INSTALLED )); then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      >/etc/apt/sources.list.d/github-cli.list
    run_logged "${NI_APT[@]}" update
    run_logged "${NI_APT[@]}" install gh
    profile_set NI_GH_INSTALLED 1
    notes+=("gh installed")
  fi

  as_user 'git config --global init.defaultBranch main; git config --global pull.rebase false'
  if [[ -n "${NICODE_GIT_NAME:-}" && -z "$NI_GIT_NAME" ]]; then
    as_user "git config --global user.name $(printf '%q' "$NICODE_GIT_NAME")"
    profile_set NI_GIT_NAME "$NICODE_GIT_NAME"
  fi
  if [[ -n "${NICODE_GIT_EMAIL:-}" && -z "$NI_GIT_EMAIL" ]]; then
    as_user "git config --global user.email $(printf '%q' "$NICODE_GIT_EMAIL")"
    profile_set NI_GIT_EMAIL "$NICODE_GIT_EMAIL"
  fi
  (( NI_GH_AUTHED )) && as_user 'gh auth setup-git' && notes+=("gh logged in")
  [[ -n "$NI_GIT_NAME" ]] && notes+=("identity: $NI_GIT_NAME") || notes+=("identity from GitHub login later")

  step_detail "$(join_by ', ' "${notes[@]}")"
}

# shellcheck shell=bash
# Step 6 — Claude Code CLI for the target user. Login is NOT done here: it happens from the app
# (daemon setup API) or with `nicode login`, because OAuth needs a browser.

step_claude() {
  local notes=()
  if [[ -z "$NI_CLAUDE_BIN" ]]; then
    # Native installer (self-updating, lives in ~/.local/bin). Optional pinned version.
    if ! as_user "curl -fsSL https://claude.ai/install.sh | bash -s -- ${NICODE_CLAUDE_VERSION:-}"; then
      log_warn "Native Claude installer failed; falling back to npm."
      run_logged npm install -g "@anthropic-ai/claude-code${NICODE_CLAUDE_VERSION:+@$NICODE_CLAUDE_VERSION}"
    fi
    notes+=("installed")
  fi

  # Make sure ~/.local/bin is on PATH for login shells (tmux, daemon-spawned shells).
  as_user 'grep -q "HOME/.local/bin" ~/.profile 2>/dev/null || echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.profile'

  local bin ver
  bin="$(as_user_capture 'command -v claude || ls ~/.local/bin/claude 2>/dev/null' | head -n1)"
  [[ -n "$bin" ]] || { step_detail "claude binary not found after install"; return 1; }
  ver="$(as_user_capture "$bin --version" | head -n1)"
  profile_set NI_CLAUDE_BIN "$bin"
  profile_set NI_CLAUDE_VERSION "$ver"

  # Env file the daemon loads (holds CLAUDE_CODE_OAUTH_TOKEN after login).
  local envf="$NI_USER_HOME/.config/nicode/env"
  if [[ ! -f "$envf" ]]; then
    printf '# niCode daemon environment. CLAUDE_CODE_OAUTH_TOKEN is written by the app login or `nicode login`.\n' >"$envf"
    chown "$NI_USER:$NI_USER" "$envf"
    chmod 600 "$envf"
  fi

  if (( NI_CLAUDE_AUTHED )); then notes+=("$ver, logged in"); else notes+=("$ver, login pending"); fi
  step_detail "$(IFS=';'; echo "${notes[*]}")"
}

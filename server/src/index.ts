import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { app } from './app.js';
import { configPath, loadConfig } from './config.js';
import { events } from './events.js';
import { applyTokenChange, closeAllClients, startHttpServer } from './http.js';
import { log } from './log.js';
import { initClaudeModule, registerClaudeModule, shutdownClaude } from './modules/claude.js';
import { registerFsModule } from './modules/fs.js';
import { registerGitModule } from './modules/git.js';
import { registerProjectsModule } from './modules/projects.js';
import { registerPushModule } from './modules/push.js';
import { registerServerModule } from './modules/server.js';
import { registerSetupModule } from './modules/setup.js';
import { detachAllTerms, registerTermModule } from './modules/term.js';
import { setClaudeReadyCheck } from './rpc.js';

async function main(): Promise<void> {
  const cfgPath = configPath();
  app.init(loadConfig(cfgPath));
  await mkdir(app.config.dataDir, { recursive: true, mode: 0o700 });
  await app.probeClaude();

  // Setup state as the app sees it: ready once Claude is logged in (any method).
  const state = app.claudeLoggedIn() ? 'ready' : 'needs_claude_login';
  events.emit('setup.progress', await app.status.setState(state));
  setClaudeReadyCheck(() => app.claudeLoggedIn());

  registerServerModule();
  registerSetupModule();
  registerProjectsModule();
  registerFsModule();
  registerGitModule();
  registerTermModule();
  registerClaudeModule();
  registerPushModule();
  await initClaudeModule();

  const server = startHttpServer();

  // Device tokens change via `nicode token add/revoke` (SIGHUP) or edits to the config file.
  const reloadTokens = () => {
    try {
      app.config.tokens = loadConfig(cfgPath).tokens;
      applyTokenChange();
      log.info({ devices: app.config.tokens.length }, 'device tokens reloaded');
    } catch (err) {
      log.warn({ err }, 'could not reload config');
    }
  };
  let debounce: NodeJS.Timeout | null = null;
  try {
    watch(cfgPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(reloadTokens, 200);
    });
  } catch (err) {
    log.warn({ err }, 'config file watch unavailable; use SIGHUP to reload');
  }
  process.on('SIGHUP', reloadTokens);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    shutdownClaude();
    detachAllTerms(); // tmux sessions keep running
    closeAllClients();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'niCode daemon failed to start');
  process.exit(1);
});

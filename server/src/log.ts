import pino from 'pino';

/** JSON logs to stdout (journald). Secrets are redacted wherever they could appear. */
export const log = pino({
  level: process.env.NICODE_LOG_LEVEL ?? 'info',
  base: undefined,
  redact: {
    // (Not `code`: error objects use it for ENOENT etc. Login/pairing codes are never logged.)
    paths: ['token', '*.token', 'authorization', '*.authorization', 'headers.authorization', 'CLAUDE_CODE_OAUTH_TOKEN', '*.CLAUDE_CODE_OAUTH_TOKEN'],
    censor: '[redacted]',
  },
});

/** Masks Claude OAuth tokens and long hex tokens inside free text (PTY output, errors). */
export function maskSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]')
    .replace(/\b[a-f0-9]{64}\b/g, '[redacted-token]');
}

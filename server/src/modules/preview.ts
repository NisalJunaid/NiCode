/**
 * Live preview: open a port (pm2 app or a dev server niCode starts) on its own HTTPS address,
 * p<port>.<ip-dashed>.sslip.io, signed in with a one-time link. Domains are previewed by the
 * app directly. See preview/auth.ts for the sign-in scheme and preview/proxy.ts for the gate.
 */
import { z } from 'zod';
import type { PreviewLink, PreviewStatus } from '../../../protocol/types.js';
import { app } from '../app.js';
import { issueOpenToken, previewHost } from '../preview/auth.js';
import { devOptions, devStart, devStatus, devStop } from '../preview/dev.js';
import { register, RpcError } from '../rpc.js';
import { portListening } from '../util/net.js';
import { Steps } from '../util/steps.js';
import { projectOf } from './projects.js';
import { ensurePreviewSite, listPreviewSites, removePreviewSite, serverIp, status as sitesStatus } from './sites.js';

// Tests (and machines without nginx): skip nginx/certbot and hand out plain-http links.
const NO_NGINX = process.env.NICODE_TEST_PREVIEW_NO_NGINX === '1';

const Port = z.number().int().min(1024).max(65535);

async function previewStatus(): Promise<PreviewStatus> {
  if (NO_NGINX) return { supported: true };
  const st = await sitesStatus();
  return st.supported ? { supported: true } : { supported: false, reason: st.reason ?? 'Previews need nginx on this server.' };
}

async function openPreview(port: number, deviceId: string, opId?: string): Promise<PreviewLink> {
  if (port === app.config.port) throw new RpcError('forbidden', 'That is niCode itself');
  const steps = new Steps(opId);
  steps.set('check', `Port ${port} answers`, 'running');
  if (!(await portListening(port))) {
    steps.set('check', `Port ${port} answers`, 'failed', 'Nothing is listening there. Start the app or dev server first.');
    throw new RpcError('bad_request', `Nothing is running on port ${port}`);
  }
  steps.set('check', `Port ${port} answers`, 'done');
  const ip = NO_NGINX ? (process.env.NICODE_TEST_PREVIEW_IP ?? '127.0.0.1') : await serverIp();
  if (!ip) throw new RpcError('internal', "Couldn't find this server's public IP address");
  const host = previewHost(port, ip);
  const { https } = NO_NGINX ? { https: false } : await ensurePreviewSite(port, host, steps);
  const base = NO_NGINX ? `http://${host}:${app.config.port}` : `${https ? 'https' : 'http'}://${host}`;
  return { url: `${base}/__nicode/auth?t=${issueOpenToken(port, deviceId)}`, host, port, https };
}

export function registerPreviewModule(): void {
  register('preview.status', z.object({}).passthrough(), previewStatus);
  register('preview.open', z.object({ port: Port, opId: z.string().max(64).optional() }), ({ port, opId }, ctx) => openPreview(port, ctx.device.id, opId));
  register('preview.list', z.object({}).passthrough(), () => (NO_NGINX ? [] : listPreviewSites()));
  register('preview.close', z.object({ port: Port }), async ({ port }) => {
    if (!NO_NGINX) await removePreviewSite(port);
    return { ok: true as const };
  });

  register('preview.devOptions', z.object({ projectPath: z.string() }), async ({ projectPath }) => devOptions(await projectOf(projectPath)));
  register('preview.devStart', z.object({ projectPath: z.string(), opId: z.string().max(64).optional() }), async ({ projectPath, opId }) =>
    devStart(await projectOf(projectPath), opId),
  );
  register('preview.devStop', z.object({ projectPath: z.string() }), async ({ projectPath }) => {
    devStop(await projectOf(projectPath));
    return { ok: true as const };
  });
  register('preview.devStatus', z.object({ projectPath: z.string() }), async ({ projectPath }) => devStatus(await projectOf(projectPath)));
}

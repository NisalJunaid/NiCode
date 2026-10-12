/**
 * Phone pairing and login end to end against the real daemon:
 * one-time code → public key registered → fresh signed challenge on every connection.
 */
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authMessage, signatureHeader } from '../../protocol/types.js';
import { Client, sha, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

let d: TestDaemon;
const base = () => `http://127.0.0.1:${d.port}`;

/** What `nicode pair` writes: hashed one-time code with an expiry. */
async function addPairingCode(code: string, expiresInMs = 600_000): Promise<void> {
  const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
  cfg.pairingCodes = [...(cfg.pairingCodes ?? []), { sha256: sha(code.replace(/-/g, '')), name: 'test', expiresAt: new Date(Date.now() + expiresInMs).toISOString() }];
  await writeFile(d.cfgPath, JSON.stringify(cfg));
  await new Promise((r) => setTimeout(r, 400)); // let the daemon's config watcher reload
}

const pair = (body: Record<string, unknown>) =>
  fetch(`${base()}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function signedLogin(deviceId: string, privateKey: KeyObject, hash: string | null): Promise<string> {
  const { nonce } = (await (await fetch(`${base()}/auth/challenge`)).json()) as { nonce: string };
  const sig = sign(hash, Buffer.from(authMessage(nonce, deviceId)), privateKey).toString('base64');
  return signatureHeader(deviceId, nonce, sig);
}

beforeAll(async () => {
  d = await startDaemon();
}, 30_000);
afterAll(() => d?.stop());

describe('phone pairing + signed login', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }); // what react-native-biometrics creates
  const rsaPub = (rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  let deviceId = '';

  it('pairs with a one-time code and the phone public key', async () => {
    await addPairingCode('ABCDE-FGHJK');
    const wrong = await pair({ code: 'ZZZZZ-ZZZZZ', deviceName: 'Pixel', alg: 'RS256', publicKey: rsaPub });
    expect(wrong.status).toBe(401);
    const badKey = await pair({ code: 'ABCDE-FGHJK', deviceName: 'Pixel', alg: 'RS256', publicKey: 'bm90IGEga2V5IGF0IGFsbA==' });
    expect(badKey.status).toBe(400);

    const ok = await pair({ code: 'abcde fghjk', deviceName: 'Pixel', alg: 'RS256', publicKey: rsaPub }); // hand-typed form
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { deviceId: string; deviceName: string };
    expect(body.deviceName).toBe('Pixel');
    deviceId = body.deviceId;
    expect(deviceId).toBe(`d_${sha(rsaPub).slice(0, 8)}`); // derivable by the phone

    const reuse = await pair({ code: 'ABCDE-FGHJK', deviceName: 'Thief', alg: 'RS256', publicKey: rsaPub });
    expect(reuse.status).toBe(401); // single use
    const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
    expect(cfg.pairingCodes).toEqual([]);
    expect(cfg.devices.find((x: any) => x.id === deviceId)).toMatchObject({ alg: 'RS256', publicKey: rsaPub });
  });

  it('logs in with a fresh signature and rejects replays', async () => {
    const header = await signedLogin(deviceId, rsa.privateKey, 'sha256');
    const c = await Client.connectWith(d.port, header);
    expect((await c.call('server.info')).result.device).toMatchObject({ id: deviceId, kind: 'key', name: 'Pixel' });
    c.close();
    // The exact same header (captured traffic) must not work twice.
    await expect(Client.connectWith(d.port, header)).rejects.toThrow('401');
    // Fresh login still works and resets the failure counter.
    (await Client.connectWith(d.port, await signedLogin(deviceId, rsa.privateKey, 'sha256'))).close();
  });

  it('rejects signatures from another key and logins for unknown devices', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(Client.connectWith(d.port, await signedLogin(deviceId, other.privateKey, 'sha256'))).rejects.toThrow('401');
    await expect(Client.connectWith(d.port, await signedLogin('d_nobody', rsa.privateKey, 'sha256'))).rejects.toThrow('401');
    (await Client.connectWith(d.port, await signedLogin(deviceId, rsa.privateKey, 'sha256'))).close();
  });

  it('supports Ed25519 and ES256 phones too', async () => {
    for (const [alg, kp, hash, pub] of [
      ['Ed25519', generateKeyPairSync('ed25519'), null, (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')],
      ['ES256', generateKeyPairSync('ec', { namedCurve: 'P-256' }), 'sha256', (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')],
    ] as const) {
      const code = alg === 'ES256' ? 'EEEEE-22222' : 'DDDDD-11111';
      await addPairingCode(code);
      const res = await pair({ code, deviceName: alg, alg, publicKey: pub(kp.publicKey) });
      expect(res.status).toBe(200);
      const { deviceId: id } = (await res.json()) as { deviceId: string };
      const c = await Client.connectWith(d.port, await signedLogin(id, kp.privateKey, hash));
      expect((await c.call('server.info')).result.device.name).toBe(alg);
      c.close();
    }
  });

  it('rejects expired pairing codes and legacy permanent tokens', async () => {
    await addPairingCode('XXXXX-YYYYY', -1000);
    expect((await pair({ code: 'XXXXX-YYYYY', deviceName: 'late', alg: 'RS256', publicKey: rsaPub })).status).toBe(401);

    const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
    cfg.devices.push({ id: 'd_legacy', name: 'installer', sha256: sha('f'.repeat(64)), createdAt: new Date().toISOString() });
    await writeFile(d.cfgPath, JSON.stringify(cfg));
    await new Promise((r) => setTimeout(r, 400));
    await expect(Client.connect(d.port, 'f'.repeat(64))).rejects.toThrow('401');
    (await Client.connect(d.port, TOKEN)).close(); // reset backoff
  });

  it('revoking a phone ends its open connection immediately', async () => {
    const phone = await Client.connectWith(d.port, await signedLogin(deviceId, rsa.privateKey, 'sha256'));
    const admin = await Client.connect(d.port, TOKEN);
    const list = (await admin.call('auth.devices')).result;
    expect(list.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Pixel', 'test phone']));
    expect(list.map((x: any) => x.name)).not.toContain('installer'); // legacy tokens are hidden
    expect((await admin.call('auth.revoke', { id: deviceId })).result.ok).toBe(true);
    for (let i = 0; i < 50 && !phone.closed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(phone.closed?.code).toBe(4401);
    await expect(Client.connectWith(d.port, await signedLogin(deviceId, rsa.privateKey, 'sha256'))).rejects.toThrow('401');
    admin.close();
  });
});

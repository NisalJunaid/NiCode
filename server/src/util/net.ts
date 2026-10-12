import net from 'node:net';

/** True if something accepts TCP connections on 127.0.0.1:port. */
export function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(400, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function waitForPort(port: number, ms: number, stop?: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portListening(port)) return true;
    if (stop?.()) return false;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/** A port nobody listens on, from `from` upwards. */
export async function freePort(from: number, used: Set<number> = new Set()): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    if (used.has(p) || (await portListening(p))) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('No free port found');
}

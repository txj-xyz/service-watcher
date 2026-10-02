import tls from "node:tls";

const cache = new Map<string, { expires: Date; fetchedAt: number }>();
const CACHE_MS = 60 * 60 * 1000;

/** Returns when the TLS certificate served at host:port expires. Cached for an hour. */
export async function getCertExpiry(host: string, port: number, timeout: number): Promise<Date> {
  const key = `${host}:${port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.expires;

  const expires = await new Promise<Date>((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) reject(new Error("no certificate presented"));
      else resolve(new Date(cert.valid_to));
    });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error("timed out reading certificate"));
    });
    socket.on("error", reject);
  });
  cache.set(key, { expires, fetchedAt: Date.now() });
  return expires;
}

/** Returns a degraded/failed note if the cert is expired or close to it, otherwise null. */
export async function certNote(
  host: string,
  port: number,
  timeout: number,
  warnDays: number,
): Promise<{ failed: boolean; note: string; daysLeft: number } | null> {
  const expires = await getCertExpiry(host, port, timeout);
  const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) return { failed: true, note: `TLS certificate expired ${-daysLeft}d ago`, daysLeft };
  if (daysLeft <= warnDays) return { failed: false, note: `TLS certificate expires in ${daysLeft}d`, daysLeft };
  return null;
}

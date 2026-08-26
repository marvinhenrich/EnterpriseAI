import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { getRequestListener } from '@hono/node-server';
import { env, isAdConfigured } from './config/env.ts';
import { log } from './lib/logger.ts';
import { branding } from './config/branding.ts';

// =============================================================================
// Bootstrap. Reihenfolge ist sicherheitsrelevant:
//   1. Sockets binden (ggf. Port 443 → braucht root)
//   2. Privilegien auf einen unprivilegierten Nutzer fallenlassen
//   3. ERST DANN die App (inkl. DB-Verbindung) laden → läuft unprivilegiert
// So muss der datenverarbeitende Code nicht als root laufen.
// =============================================================================

function resolvePath(p: string): string {
  return p.startsWith('/') ? p : `${process.cwd()}/${p}`;
}

// Ermittelt die IPv4 des Firmen-Interfaces (z. B. en0) für striktes Binden.
// Fallback auf HOST, falls das Interface (noch) nicht da ist → KI bleibt oben.
function resolveExternalHost(): string {
  if (env.BIND_INTERFACE) {
    const addrs = networkInterfaces()[env.BIND_INTERFACE] ?? [];
    const v4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
    log.warn('BIND_INTERFACE nicht gefunden — Fallback auf HOST', { iface: env.BIND_INTERFACE, host: env.HOST });
  }
  return env.HOST;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    server.once('error', onErr);
    server.listen(port, host, () => {
      server.removeListener('error', onErr);
      resolve();
    });
  });
}

function dropPrivileges(): void {
  const user = env.DROP_TO_USER;
  if (!user) return; // nicht konfiguriert → kein Drop (z. B. Dev)
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return; // nicht root
  if (typeof process.setgid !== 'function' || typeof process.setuid !== 'function') return; // kein POSIX
  try {
    const group = env.DROP_TO_GROUP || user;
    process.setgid(group);
    process.setuid(user);
    log.info('🔒 Privilegien fallengelassen', { user, group, uid: process.getuid?.() });
  } catch (err) {
    log.error('Privilege-Drop fehlgeschlagen — Abbruch (kein Betrieb als root)', { error: (err as Error).message });
    process.exit(1);
  }
}

// --- 1. Sockets binden (als root, falls 443) --------------------------------
// HTTP nur auf Loopback (lokale Health-Checks/Tooling) — nie nach außen.
const httpServer = createHttpServer();
await listen(httpServer, env.PORT, '127.0.0.1');
log.info('HTTP gebunden (nur localhost)', { port: env.PORT });

// HTTPS nur ans Firmen-Interface → vom WLAN/Internet-Segment NICHT erreichbar.
const httpsHost = resolveExternalHost();
let httpsServer: ReturnType<typeof createHttpsServer> | undefined;
if (env.HTTPS_PORT > 0) {
  try {
    const cert = readFileSync(resolvePath(env.TLS_CERT_PATH));
    const key = readFileSync(resolvePath(env.TLS_KEY_PATH));
    httpsServer = createHttpsServer({ cert, key });
    await listen(httpsServer, env.HTTPS_PORT, httpsHost);
    log.info('HTTPS gebunden (nur Firmen-Interface)', { port: env.HTTPS_PORT, host: httpsHost });
  } catch (err) {
    log.error('HTTPS-Bind fehlgeschlagen', { port: env.HTTPS_PORT, host: httpsHost, error: (err as Error).message });
    httpsServer = undefined;
  }
}

// --- 2. Privilegien droppen --------------------------------------------------
dropPrivileges();

// --- 3. App laden (DB öffnet jetzt unprivilegiert) + an Sockets hängen -------
const { app } = await import('./app.ts');
const listener = getRequestListener(app.fetch);
httpServer.on('request', listener);
httpsServer?.on('request', listener);

log.info(`🚀 ${branding.appName} bereit`, {
  http: env.PORT,
  https: env.HTTPS_PORT || '–',
  adConfigured: isAdConfigured,
  requiredGroup: env.AD_REQUIRED_GROUP || '(deaktiviert)',
  model: env.OLLAMA_MODEL,
});

// --- 4. Warmup + Memory-Cleanup (nach Drop) ---------------------------------
const { warmupModel } = await import('./llm/ollama.ts');
warmupModel();
const { cleanupExpiredMemories } = await import('./lib/memory.ts');
cleanupExpiredMemories();
setInterval(() => cleanupExpiredMemories(), 6 * 60 * 60 * 1000).unref();

// --- Sauberes Herunterfahren -------------------------------------------------
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`Signal ${sig} empfangen, beende Server`);
    httpsServer?.close();
    httpServer.close(() => process.exit(0));
  });
}

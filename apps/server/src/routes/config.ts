import { Hono } from 'hono';
import { branding } from '../config/branding.ts';
import { unternehmen, setzeUnternehmen, SPRACHEN } from '../lib/unternehmen.ts';
import { findeDatei } from '../config/pfade.ts';
import { modulAktiv, modulListe, setzeModul, abhaengigeVon, MODULE } from '../lib/module.ts';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { logChange, requestMeta } from '../lib/audit.ts';
import type { AppEnv } from '../types.ts';

// =============================================================================
// Erscheinungsbild und Modulzustand für die Oberfläche.
//
// Das Frontend enthält KEINEN Firmennamen. Es fragt beim Start hier nach, wie
// die Installation heißt und welche Bereiche es überhaupt anzeigen soll.
// =============================================================================

export const configRoutes = new Hono<AppEnv>();

/**
 * Ohne Anmeldung erreichbar: Der Anmeldebildschirm braucht Name und Farbe,
 * bevor jemand angemeldet ist. Enthält bewusst nichts Vertrauliches.
 */
configRoutes.get('/branding', (c) => {
  const u = unternehmen();
  return c.json({
    appName: u.appName,
    appShort: u.appShort,
    organisation: u.organisation,
    farbe: u.farbe,
    // Die Sprache reist hier mit: Der Anmeldebildschirm braucht sie, bevor es
    // eine Sitzung gibt, und ein zweiter Abruf dafuer waere verschwendet.
    sprache: u.sprache,
    hatLogo: !!findeDatei('assets/logo.png', [branding.logoPfad, '../web/public/logo.png', '../web/dist/logo.png'].filter(Boolean)),
  });
});

/**
 * Unternehmens-Konfiguration aendern. Nur Administratoren.
 *
 * Wirkt sofort und ohne Neustart: die Werte liegen in der Datenbank und werden
 * bei jedem Abruf gelesen. Was hier nicht gesetzt ist, faellt auf die
 * Umgebungsvariable zurueck.
 */
configRoutes.patch('/unternehmen', authenticate, requirePermission('admin.system.settings'), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Es wurden keine Werte uebergeben.' }, 400);
  }
  const vorher = unternehmen();
  const r = setzeUnternehmen(body as Record<string, string>);
  if (!r.ok) return c.json({ error: r.fehler }, 400);
  const nachher = unternehmen();
  const u = c.get('user')!;
  logChange({
    c, userId: u.id, username: u.username,
    action: 'UNTERNEHMEN_GEAENDERT', resourceType: 'system',
    before: vorher as unknown as Record<string, unknown>,
    after: nachher as unknown as Record<string, unknown>,
  });
  return c.json(nachher);
});

/** Welche Sprachen die Oberflaeche anbietet. */
configRoutes.get('/sprachen', (c) => c.json({ sprachen: SPRACHEN }));

/**
 * Logo der Installation. Erst der konfigurierte Pfad, dann die üblichen
 * Ablageorte. Ohne Anmeldung erreichbar — der Anmeldebildschirm zeigt es.
 */
configRoutes.get('/branding/logo', async (c) => {
  const pfad = findeDatei('assets/logo.png', [
    branding.logoPfad,
    '../web/public/logo.png',
    '../web/dist/logo.png',
  ].filter(Boolean));
  if (!pfad) return c.body(null, 404);
  const { readFile } = await import('node:fs/promises');
  const daten = await readFile(pfad).catch(() => null);
  if (!daten) return c.body(null, 404);
  c.header('Content-Type', pfad.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(new Uint8Array(daten));
});

/** Aktive Module — steuert, welche Menüpunkte die Oberfläche zeigt. */
configRoutes.get('/modules', authenticate, (c) =>
  c.json({ aktiv: MODULE.filter((m) => modulAktiv(m.id)).map((m) => m.id) }),
);

/** Vollständige Übersicht mit Zweck und Abhängigkeiten — nur für Administratoren. */
configRoutes.get('/admin/modules', authenticate, requirePermission('admin.access'), (c) =>
  c.json({ module: modulListe() }),
);

configRoutes.patch('/admin/modules/:id', authenticate, requirePermission('admin.access'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const body = (await c.req.json().catch(() => ({}))) as { aktiv?: boolean };
  const aktiv = body.aktiv === true;
  const vorher = modulAktiv(id);

  // Beim Abschalten sagen, was mitgeht — sonst verschwinden Funktionen, deren
  // Zusammenhang niemand auf dem Schirm hatte.
  const mitBetroffen = aktiv ? [] : abhaengigeVon(id).filter((m) => modulAktiv(m.id)).map((m) => m.name);

  try {
    setzeModul(id, aktiv);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  logChange({ c, userId: user.id, username: user.username, action: 'MODULE_TOGGLED', resourceType: 'system',
    resourceId: id, before: { aktiv: vorher }, after: { aktiv } });
  return c.json({ ok: true, id, aktiv, mitBetroffen });
});

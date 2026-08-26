import { Hono } from 'hono';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import {
  addLabel, listLabels, deleteLabel, labelStats,
  listTerms, addTerms, deleteTerm, clearTerms, retranslateAll,
  currentScan, startScan, cancelScan,
} from '../lib/labels.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import type { AppEnv } from '../types.ts';
import { modulAktiv } from '../lib/module.ts';

// Geteilte Etiketten-Datenbank. Granulare Rechte: labels.read/write/delete.
// Ein gemeinsamer Scan-Job, Live-Status für alle. Rein intern.

export const labelRoutes = new Hono<AppEnv>();
labelRoutes.use('*', authenticate);

// Modul abgeschaltet -> Bereich existiert für den Nutzer nicht. Die Route
// antwortet dann einheitlich mit 404, statt halb zu funktionieren.
labelRoutes.use('*', async (c, next) => {
  if (!modulAktiv('labels')) return c.json({ error: 'Dieser Bereich ist in dieser Installation nicht aktiv.' }, 404);
  await next();
});

// --- Übersicht / Labels ------------------------------------------------------
labelRoutes.get('/labels', requirePermission('labels.read'), (c) =>
  c.json({ labels: listLabels(), stats: labelStats(), scan: scanView() }),
);

labelRoutes.post('/labels', requirePermission('labels.write'), async (c) => {
  const user = c.get('user');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    log.warn('[Labels] Formulardaten nicht lesbar', { error: (err as Error).message });
    return c.json({ error: `Upload konnte nicht gelesen werden: ${(err as Error).message}` }, 400);
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return c.json({ error: 'Keine Datei übermittelt' }, 400);
  if (files.length > env.MAX_FILES_PER_QUERY) return c.json({ error: `Maximal ${env.MAX_FILES_PER_QUERY} Dateien pro Upload` }, 400);
  // KEINE Größenbeschränkung. Druckdaten für Etiketten sind regelmäßig sehr
  // groß, und die Datei wird ohnehin direkt auf die Platte geschrieben, nicht
  // in der Datenbank gehalten. Gemessen: 800 MB laufen durch die Verarbeitung
  // in 0,3 s. Begrenzend ist allein der freie Plattenplatz (1,5 TB).
  let added = 0;
  for (const f of files) {
    try {
      addLabel(user.id, user.username, f.name, Buffer.from(await f.arrayBuffer()));
      added++;
    } catch (err) {
      // Statt einer pauschalen Meldung sagen, WAS schiefging und bei welcher
      // Datei — sonst sucht der Nutzer die Ursache bei der Dateigröße.
      const grund = (err as Error).message;
      log.error('[Labels] Upload fehlgeschlagen', { datei: f.name, groesse: f.size, error: grund });
      return c.json({
        error: `„${f.name}" (${(f.size / 1048576).toFixed(1)} MB) konnte nicht gespeichert werden: ${grund}`,
        bereitsGespeichert: added,
      }, 500);
    }
  }
  log.info('[Labels] Upload', { user: user.username, added });
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'LABEL_UPLOADED', resourceType: 'label',
    details: { anzahl: added, dateien: files.map((f) => f.name).join(', ') } });
  return c.json({ added, labels: listLabels(), stats: labelStats() }, 201);
});

labelRoutes.delete('/labels/:id', requirePermission('labels.delete'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id || !deleteLabel(id)) return c.json({ error: 'Etikett nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'LABEL_DELETED', resourceType: 'label', resourceId: id });
  return c.json({ ok: true, stats: labelStats() });
});

// --- Begriffe (Richtlinie) ---------------------------------------------------
labelRoutes.get('/labels/terms', requirePermission('labels.read'), (c) => c.json({ terms: listTerms() }));

const termsSchema = z.object({ terms: z.array(z.string()).optional(), text: z.string().optional() });
labelRoutes.post('/labels/terms', requirePermission('labels.write'), async (c) => {
  const user = c.get('user');
  const parsed = termsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'terms oder text erforderlich' }, 400);
  const list = parsed.data.terms ?? (parsed.data.text ?? '').split('\n');
  const cleaned = list.map((t) => t.trim()).filter(Boolean).slice(0, 2000);
  if (cleaned.length === 0) return c.json({ error: 'Keine gültigen Begriffe' }, 400);
  const added = addTerms(user.id, cleaned);
  return c.json({ added, terms: listTerms() }, 201);
});

labelRoutes.delete('/labels/terms/:id', requirePermission('labels.delete'), (c) => {
  const id = Number(c.req.param('id'));
  if (!id || !deleteTerm(id)) return c.json({ error: 'Begriff nicht gefunden' }, 404);
  return c.json({ ok: true, terms: listTerms() });
});

labelRoutes.post('/labels/terms/clear', requirePermission('labels.delete'), (c) => c.json({ ok: true, removed: clearTerms() }));

// Begriffe neu in alle Sprachen übersetzen (gpt-oss). Läuft im Hintergrund.
labelRoutes.post('/labels/terms/translate', requirePermission('labels.write'), (c) => {
  void retranslateAll();
  return c.json({ ok: true });
});

// --- Scan (geteilt, live) ----------------------------------------------------
function scanView() {
  const s = currentScan();
  if (!s) return null;
  let etaSec: number | null = null;
  if (s.status === 'running' && s.done > 0 && s.startedAt) {
    const startMs = new Date(s.startedAt.replace(' ', 'T') + 'Z').getTime(); // SQLite UTC → ISO
    const elapsed = (Date.now() - startMs) / 1000;
    if (elapsed > 0 && s.done < s.total) etaSec = Math.round((elapsed / s.done) * (s.total - s.done));
  }
  return {
    id: s.id, status: s.status, total: s.total, done: s.done, hits: s.hits, termCount: s.termCount,
    startedByName: s.startedByName, startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error, etaSec,
  };
}

labelRoutes.get('/labels/scan', requirePermission('labels.read'), (c) => c.json({ scan: scanView() }));

labelRoutes.post('/labels/scan', requirePermission('labels.write'), (c) => {
  const user = c.get('user');
  try {
    startScan(user.id, user.username);
    log.info('[Labels] Scan gestartet', { user: user.username });
    return c.json({ ok: true, scan: scanView() }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

labelRoutes.post('/labels/scan/cancel', requirePermission('labels.write'), (c) =>
  cancelScan() ? c.json({ ok: true }) : c.json({ error: 'Kein laufender Scan' }, 404),
);

// --- Excel-Export ------------------------------------------------------------
labelRoutes.get('/labels/export', requirePermission('labels.read'), async (c) => {
  const rows = listLabels();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Etiketten-Prüfung');
  ws.columns = [
    { header: 'Etikett (Datei)', key: 'f', width: 44 },
    { header: 'Status', key: 's', width: 14 },
    { header: 'Gefundene Begriffe', key: 'g', width: 60 },
    { header: 'Seiten', key: 'p', width: 8 },
    { header: 'Hochgeladen von', key: 'u', width: 18 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  for (const r of rows) {
    const status = r.status === 'treffer' ? '⚠ Prüfen' : r.status === 'ok' ? 'OK' : r.status === 'fehler' ? 'Fehler' : 'offen';
    ws.addRow({ f: r.filename, s: status, g: r.found.join(', '), p: r.pages ?? '', u: r.uploadedByName ?? '' });
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Etiketten-Datenbank.xlsx"',
    },
  });
});

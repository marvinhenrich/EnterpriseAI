import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { generateDocument, type ExportFormat } from '../lib/docgen.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';
import { branding } from '../config/branding.ts';

export const exportRoutes = new Hono<AppEnv>();
exportRoutes.use('*', authenticate);

const schema = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
  format: z.enum(['docx', 'pdf', 'xlsx', 'pptx', 'html', 'csv', 'txt']),
});

// Erzeugt aus Markdown-Inhalt ein Word/PDF/Excel-Dokument zum Download.
exportRoutes.post('/export', requirePermission('docs.export'), async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'content und format erforderlich' }, 400);
  const { content, title, format } = parsed.data;
  try {
    const safeTitle = (title || `${branding.appShort} Dokument`).slice(0, 120);
    const { buffer, mime, ext } = await generateDocument(content, safeTitle, format as ExportFormat);
    const fname = `${safeTitle.replace(/[^a-zA-Z0-9-_ ]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 50) || 'dokument'}.${ext}`;
    return new Response(buffer, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${fname}"`,
      },
    });
  } catch (err) {
    log.error('[Export] Erzeugung fehlgeschlagen', { format, error: (err as Error).message });
    return c.json({ error: 'Dokument konnte nicht erzeugt werden' }, 500);
  }
});

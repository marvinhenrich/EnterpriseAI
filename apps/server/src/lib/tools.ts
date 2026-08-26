import { retrieveKb } from './kb.ts';
import { getOwnedFiles } from './files.ts';
import { spreadsheetInfo, spreadsheetQuery, isSpreadsheet } from './spreadsheet.ts';
import { log } from './logger.ts';
import { Argumente, type Spec } from './tool-args.ts';

// =============================================================================
// Werkzeuge / Function-Calls — GESCHLOSSENES SET REIN INTERNER Funktionen.
// SICHERHEITS-INVARIANTE: Kein Tool darf jemals einen Outbound-/Internet-Call
// machen. Erlaubt sind nur lokale Berechnungen und interne Datenquellen
// (Wissens-Vault, lokale Zeit). Neue Tools müssen diese Regel einhalten.
// =============================================================================

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface DocumentDescriptor {
  title: string;
  format: 'pdf' | 'docx';
  content: string; // Markdown — wird beim Download zum CI-Dokument gerendert
}

export interface ToolContext {
  userId: number;
  role: string;
  fileIds: string[]; // im aktuellen Query angehängte Dateien (für Tabellen-Tools)
  canCreateDocument?: boolean; // Permission docs.export
  onDocument?: (doc: DocumentDescriptor) => void; // erzeugtes Dokument an die UI durchreichen
  // Rechenergebnisse mitschreiben, damit die fertige Antwort dagegen geprüft
  // werden kann (siehe pruefeZahlen in lib/recipe.ts).
  /**
   * Meldet, dass dieses Werkzeug eine EINGESTUFTE Quelle gelesen hat. Der Chat
   * wird dadurch hochgestuft. Ohne das gelangen ERP-Daten und
   * Laborwerte in Gespräche, die als 'intern' gelten — und damit ins Gedächtnis
   * und in geteilte Chats.
   */
  onKlasse?: (k: 'offen' | 'intern' | 'vertraulich' | 'geheim') => void;
}

// Ollama-Tool-Definitionen (werden dem Modell angeboten).
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_current_date',
      description: 'Gibt das aktuelle Datum und die Uhrzeit zurück.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Berechnet einen arithmetischen Ausdruck, z. B. "200 * 1.19" oder "(50+30)/2".',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Arithmetischer Ausdruck (nur Zahlen und + - * / ( ) . %)' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description: 'Durchsucht das interne Firmen-Wissens-Vault (Notizen und Dokumente) nach relevanten Informationen.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Suchbegriff oder Frage' } },
        required: ['query'],
      },
    },
  },
] as const;

// Dokument-Werkzeug (aktiv mit Permission docs.export). Erzeugt auf Wunsch ein
// CI-gestaltetes Dokument (PDF/Word) zum Download — statt eines Export-Buttons.
export const DOC_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'create_document',
      description:
        'Erstellt ein professionelles, im Erscheinungsbild des Hauses gestaltetes Dokument (PDF oder Word) und stellt es dem Nutzer zum Download bereit. ' +
        'Nutze dieses Werkzeug, sobald der Nutzer um ein herunterladbares/druckbares Dokument bittet — z. B. Angebot, Schreiben, Bericht, Protokoll, Übersicht, Datenblatt. ' +
        'Schreibe den vollständigen, gut strukturierten Inhalt selbst. Nach dem Aufruf genügt eine kurze Begleitnachricht; den Inhalt NICHT zusätzlich im Chat wiederholen.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titel/Überschrift des Dokuments' },
          format: { type: 'string', enum: ['pdf', 'docx'], description: 'Dateiformat: "pdf" (Standard) oder "docx" (Word, bearbeitbar)' },
          content: { type: 'string', description: 'Vollständiger Dokumentinhalt als Markdown: Überschriften (##), Listen (-), **fett**, Tabellen (| Spalte | Spalte |). Komplett ausformuliert.' },
        },
        required: ['title', 'content'],
      },
    },
  },
] as const;

// Tabellen-Tools (nur aktiv, wenn eine Excel/CSV angehängt ist + Permission docs.sheet).
export const SHEET_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'spreadsheet_info',
      description: 'Zeigt Struktur der angehängten Tabelle: Blätter, Spaltennamen, Zeilenzahl, Beispielzeile. Immer ZUERST aufrufen.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spreadsheet_query',
      description: 'Wertet die angehängte Tabelle programmatisch aus: filtern, Spalten wählen, sortieren, aggregieren (sum/avg/count/min/max), gruppieren. Für große Listen, die nicht in den Kontext passen.',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Blattname (optional)' },
          filters: {
            type: 'array',
            description: 'Filter (UND-verknüpft)',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: ['=', '!=', '>', '<', '>=', '<=', 'contains'] },
                value: { type: 'string' },
              },
            },
          },
          columns: { type: 'array', items: { type: 'string' }, description: 'Anzuzeigende Spalten (optional)' },
          aggregate: {
            type: 'object',
            properties: { func: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] }, column: { type: 'string' } },
          },
          groupBy: { type: 'string' },
          sortBy: { type: 'object', properties: { column: { type: 'string' }, desc: { type: 'boolean' } } },
          limit: { type: 'number' },
        },
      },
    },
  },
] as const;




export const TOOL_LABELS: Record<string, string> = {
  get_current_date: 'Datum/Uhrzeit',
  calculate: 'Rechner',
  search_knowledge_base: 'Wissens-Vault',
  create_document: 'Dokument erstellen',
  spreadsheet_info: 'Tabelle (Struktur)',
  spreadsheet_query: 'Tabelle (Auswertung)',
  verify_numbers: 'Zahlen prüfen',
};

const zahl2 = (n: number, stellen = 2): string =>
  n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });


/** Sichere Arithmetik-Auswertung (nur Zahlen/Operatoren, kein Code). */
function safeCalc(expr: string): string {
  const clean = String(expr ?? '').trim();
  if (!/^[0-9+\-*/().%\s]+$/.test(clean) || clean.length > 200) {
    return 'Ungültiger Ausdruck (nur Zahlen und + - * / ( ) . % erlaubt).';
  }
  try {
    // eslint-disable-next-line no-new-func — Eingabe ist durch Regex auf reine Arithmetik beschränkt.
    const result = Function(`"use strict"; return (${clean.replace(/%/g, '/100')});`)();
    return typeof result === 'number' && Number.isFinite(result) ? String(result) : 'Berechnung nicht möglich.';
  } catch {
    return 'Berechnung fehlgeschlagen.';
  }
}


// Erwartete Argumente je Werkzeug. Alle beobachteten Fehlschreibweisen des
// Modells stehen als Alias hier — und alles, was NICHT hier steht, wird dem
// Modell als „nicht verstanden" zurückgemeldet statt still verworfen.
const SPECS: Record<string, Spec> = {
  calculate: { expression: { pflicht: true, aliase: ['ausdruck', 'formel', 'term'], beispiel: '"200 * 1.19"' } },
  search_knowledge_base: { query: { pflicht: true, aliase: ['suche', 'frage', 'suchbegriff'] } },
  create_document: {
    title: { pflicht: true, aliase: ['titel', 'ueberschrift'] },
    content: { pflicht: true, aliase: ['inhalt', 'text', 'markdown'] },
    format: { aliase: ['dateiformat', 'typ'] },
  },
};



/** Meldung voranstellen, wenn die Eingabe nicht sauber war. */
function mitBericht(a: Argumente, ergebnis: string): string {
  const b = a.bericht();
  return b ? `${b}\n\n${ergebnis}` : ergebnis;
}

/** Führt ein Tool aus. AUSSCHLIESSLICH lokale/interne Operationen. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const spec = SPECS[name];
  const A = new Argumente(args, spec ?? {});
  if (spec && A.fehltPflicht) {
    // Ohne Pflichtangabe gar nicht erst rechnen — ein Ergebnis auf halber
    // Eingabe ist schlimmer als eine klare Rückfrage.
    log.warn('[Tools] Pflichtangabe fehlt', { name, bericht: A.bericht().slice(0, 120) });
    return A.bericht();
  }
  try {
    switch (name) {
      case 'get_current_date':
        return new Date().toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
      case 'calculate':
        return mitBericht(A, safeCalc(A.text('expression')));
      case 'search_knowledge_base': {
        // Sichtbarkeitsstufen gelten auch hier — sonst umgeht die KI die Schranke.
        const hits = await retrieveKb(A.text('query'), { userId: ctx.userId, role: ctx.role }, 5);
        if (hits.length === 0) return 'Keine relevanten Einträge im Wissens-Vault gefunden.';
        return hits.map((h) => `[${h.title}] ${h.content}`).join('\n---\n');
      }
      case 'spreadsheet_info':
      case 'spreadsheet_query': {
        const file = getOwnedFiles(ctx.userId, ctx.fileIds).find((f) => isSpreadsheet(f.filename));
        if (!file) return 'Keine Tabelle (Excel/CSV) angehängt.';
        return name === 'spreadsheet_info'
          ? await spreadsheetInfo(file.storedPath)
          : await spreadsheetQuery(file.storedPath, args);
      }
      case 'create_document': {
        if (!ctx.canCreateDocument) return 'Keine Berechtigung zur Dokumenterstellung.';
        const title = A.text('title') || 'Dokument';
        const content = A.text('content');
        if (!content) return 'Kein Inhalt für das Dokument angegeben.';
        const fmt = (A.text('format') || 'pdf').toLowerCase();
        const format: DocumentDescriptor['format'] = fmt === 'docx' || fmt === 'word' ? 'docx' : 'pdf';
        ctx.onDocument?.({ title: title.slice(0, 120), format, content });
        return `Dokument „${title}" wurde als ${format.toUpperCase()} im Erscheinungsbild des Hauses erstellt und steht dem Nutzer unten zum Download bereit.`;
      }
      default:
        return `Unbekanntes Werkzeug: ${name}`;
    }
  } catch (err) {
    const meldung = (err as Error).message;
    log.warn('[Tools] Ausführung fehlgeschlagen', { name, error: meldung });
    // Eine fehlende Tabelle heißt: Die zugehörigen Daten wurden nie eingelesen.
    // Das muss klar dastehen — sonst deutet das Modell „fehlgeschlagen" als
    // vorübergehende Störung, weicht auf die allgemeine Suche aus und erfindet
    // Zahlen. Genau daraus sind früher Falschauskünfte entstanden.
    const fehlend = /no such table: (\w+)/.exec(meldung);
    if (fehlend) {
      return `Für diese Installation sind keine Daten dieser Art eingelesen (Ablage „${fehlend[1]}" fehlt). ` +
        'Diese Auskunft ist hier nicht möglich — sage das offen und rate nicht.';
    }
    return `Werkzeug "${name}" fehlgeschlagen: ${meldung}. Nenne keine Zahlen, die du nicht belegen kannst.`;
  }
}

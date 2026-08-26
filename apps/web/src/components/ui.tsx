import type { ReactNode } from 'react';

// =============================================================================
// Gemeinsame Oberflächen-Bausteine.
//
// Grundsätze (bewusst zurückhaltend, für den Dauereinsatz im Arbeitsalltag):
//  - Symbole als SVG mit einheitlicher Strichstärke — keine Emoji. Emoji sehen
//    auf jedem System anders aus, lassen sich nicht einfärben und wirken
//    unfertig.
//  - EIN Badge-System statt vieler Pillen-Varianten. Farbe trägt Bedeutung
//    (Status), nicht Dekoration.
//  - Statusfarbe als kleiner Punkt, nicht als Flächenfüllung.
// =============================================================================

const ICONS = {
  suche: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  schluessel: <><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.2-8.2M17 6l2 2M14 9l2 2" /></>,
  datenbank: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  dokument: <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" /></>,
  notiz: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
  etikett: <><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.2" /></>,
  bild: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5-4 4-2-2-5 5" /></>,
  schloss: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
  warnung: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  haken: <path d="m20 6-11 11-5-5" />,
  schliessen: <path d="M18 6 6 18M6 6l12 12" />,
  pfeilRechts: <path d="M5 12h14M13 6l6 6-6 6" />,
  pfeilUnten: <path d="M12 5v14M19 12l-7 7-7-7" />,
  zurueck: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />,
  stift: <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  radierer: <><path d="m7 21-4-4a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L13 20" /><path d="M21 21H8" /></>,
  ordner: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  projekt: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 11h18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  papierkorb: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
  chevronUnten: <path d="m6 9 6 6 6-6" />,
  chevronRechts: <path d="m9 6 6 6-6 6" />,
  aktualisieren: <><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></>,
  herunterladen: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  werkzeug: <path d="M14.7 6.3a4 4 0 0 1 5 5L16 15l3 3-2 2-3-3-3.3 3.3a4 4 0 0 1-5-5L9 12 6 9l2-2 3 3z" />,
  denken: <><path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3Z" /><path d="M9 21h6" /></>,
  auslassung: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

// --- Status ------------------------------------------------------------------

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

const DOT: Record<Tone, string> = {
  neutral: 'bg-faint',
  ok: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-accent',
};

/** Kleiner Statuspunkt — trägt die Farbe, damit Flächen ruhig bleiben. */
export function StatusDot({ tone = 'neutral', className = '' }: { tone?: Tone; className?: string }) {
  return <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${DOT[tone]} ${className}`} />;
}

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'border-border bg-surface-2 text-muted',
  ok: 'border-success/25 bg-success/8 text-success',
  warn: 'border-warn/25 bg-warn/8 text-warn',
  danger: 'border-danger/25 bg-danger/8 text-danger',
  info: 'border-accent/25 bg-accent-soft text-accent',
};

/**
 * Einheitliches Badge. Bewusst rechteckig-gerundet (nicht kreisrund) und
 * gedeckt — runde, satt gefüllte Pillen wirken schnell verspielt.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  icon,
  children,
  className = '',
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-[1.4] ${BADGE_TONE[tone]} ${className}`}
    >
      {dot && <StatusDot tone={tone} />}
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

/** Abschnittsüberschrift mit optionaler Erläuterung — einheitlich über alle Seiten. */
export function SectionTitle({ children, hint, right }: { children: ReactNode; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{children}</h2>
        {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

/** Schaltfläche zum Schließen — ersetzt die bisherigen ✕-Zeichen. */
export function CloseButton({ onClick, className = '', label = 'Schließen' }: { onClick: () => void; className?: string; label?: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-surface-2 hover:text-fg ${className}`}
    >
      <Icon name="schliessen" size={13} />
    </button>
  );
}

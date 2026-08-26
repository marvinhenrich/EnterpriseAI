import { branding } from '../lib/branding';

// =============================================================================
// Marken-Badge der Installation.
//
// Der Quelltext enthält kein bestimmtes Logo. Ist eines hinterlegt, wird es
// ausgeliefert (weiß auf farbigem Badge — so ist es in hellem wie dunklem
// Erscheinungsbild sichtbar). Fehlt eines, treten die Initialen des
// Anwendungsnamens an seine Stelle, damit nie ein leeres Feld steht.
// =============================================================================

/** „Muster GmbH KI" -> „MG". Höchstens zwei Buchstaben. */
function initialen(name: string): string {
  const woerter = name.trim().split(/\s+/).filter((w) => /^[A-Za-zÄÖÜäöü]/.test(w));
  if (woerter.length === 0) return 'KI';
  if (woerter.length === 1) return woerter[0]!.slice(0, 2).toUpperCase();
  return (woerter[0]![0]! + woerter[1]![0]!).toUpperCase();
}

export function Logo({ size = 28, radius }: { size?: number; radius?: number }) {
  const r = radius ?? Math.round(size * 0.32);
  const b = branding();
  return (
    <div
      className="grid shrink-0 place-items-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: 'linear-gradient(135deg, var(--color-accent), #60a5fa)',
        boxShadow: '0 4px 10px var(--color-ring)',
      }}
    >
      {b.hatLogo ? (
        <img
          src="/api/branding/logo"
          alt={b.appShort}
          style={{ width: Math.round(size * 0.66), height: Math.round(size * 0.66), objectFit: 'contain' }}
          // Fehlt die Datei doch, bleibt der Badge farbig statt ein kaputtes Bild zu zeigen.
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <span
          className="font-semibold text-white"
          style={{ fontSize: Math.round(size * 0.4), letterSpacing: '-0.02em' }}
        >
          {initialen(b.appName)}
        </span>
      )}
    </div>
  );
}

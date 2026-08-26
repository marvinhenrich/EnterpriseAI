import { resolve, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { env } from './env.ts';

// =============================================================================
// Wo liegt was.
//
// Trennung von Programm und Installation: Der Quellbaum enthält ausschließlich
// generischen Code. Alles, was eine konkrete Installation ausmacht — Zugangs-
// daten, Logo, Zertifikate, Datenbank, hochgeladene Dateien — liegt in einem
// Ordner daneben und wird nie mitversioniert.
//
// Damit lässt sich der Code veröffentlichen und aktualisieren, ohne dass
// jemand versehentlich Betriebsdaten mitnimmt oder eine Aktualisierung die
// örtliche Konfiguration überschreibt.
// =============================================================================

/**
 * Wurzel des Server-Arbeitsbereichs (apps/server) — unabhängig davon, von wo
 * aus gestartet wurde.
 *
 * Relative Angaben wie „./data/app.db" wurden früher gegen das
 * Arbeitsverzeichnis aufgelöst. Der Dienst startet in apps/server, ein Skript
 * aus scripts/ aber im Projektwurzel — und traf damit stillschweigend eine
 * ZWEITE, leere Datenbank. Der Bezugspunkt steht deshalb jetzt fest.
 */
export function serverWurzel(): string {
  return resolve(import.meta.dirname, '../..');
}

/** Wurzel des gesamten Projekts (eine Ebene über apps/). */
export function projektWurzel(): string {
  return resolve(serverWurzel(), '../..');
}

/** Relative Angabe gegen den Server-Arbeitsbereich auflösen. */
export function serverPfad(p: string): string {
  return isAbsolute(p) ? p : resolve(serverWurzel(), p);
}

/** Wurzel der Installationsdaten. Absolut oder relativ zum Server-Arbeitsbereich. */
export function konfigWurzel(): string {
  const p = env.CONFIG_DIR;
  return isAbsolute(p) ? p : resolve(serverWurzel(), p);
}

/** Unterordner darin, wird bei Bedarf angelegt. */
export function konfigPfad(...teile: string[]): string {
  const p = join(konfigWurzel(), ...teile);
  return p;
}

/** Ordner sicherstellen (für Ablagen, nicht für Dateien). */
export function konfigOrdner(...teile: string[]): string {
  const p = konfigPfad(...teile);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Datei erst im Installationsordner suchen, dann an den mitgelieferten
 * Rückfallorten. So überschreibt eine örtliche Datei die Vorgabe, ohne dass
 * der Quellbaum angefasst werden muss.
 */
export function findeDatei(name: string, rueckfall: string[] = []): string | null {
  const kandidaten = [konfigPfad(name), ...rueckfall.map(serverPfad)];
  return kandidaten.find((p) => existsSync(p)) ?? null;
}

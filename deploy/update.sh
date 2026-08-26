#!/usr/bin/env bash
# =============================================================================
#  EnterpriseAI aktualisieren  /  update EnterpriseAI
# =============================================================================
#
#   bash deploy/update.sh
#
#  Holt den aktuellen Stand, baut neu und startet die Dienste durch. Bricht ab,
#  bevor etwas angefasst wird, wenn es lokale Änderungen gibt — sonst würde ein
#  Update stillschweigend eigene Anpassungen verwerfen.
#
#  Der Ordner ./config wird nie angefasst: Konfiguration, Datenbank, Logo und
#  hochgeladene Dateien überstehen jedes Update.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- 1) Eigene Änderungen? ---------------------------------------------------
if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "ABBRUCH: Es gibt lokale Änderungen am Quelltext." >&2
  echo "Ein Update würde sie überschreiben. Erst sichern oder verwerfen:" >&2
  echo "  git stash        # beiseitelegen" >&2
  echo "  git checkout .   # verwerfen" >&2
  exit 1
fi

BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"

# --- 2) Sicherung ------------------------------------------------------------
# Vor dem Update, nicht danach: nach einem fehlgeschlagenen Schemawechsel ist
# eine Sicherung von „vorher" das Einzige, was noch hilft.
say "1/4  Konfiguration und Datenbank sichern"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
if [ -d config ]; then
  tar czf "backups/vor-update-$STAMP.tar.gz" config
  echo "    backups/vor-update-$STAMP.tar.gz ($(du -h "backups/vor-update-$STAMP.tar.gz" | cut -f1))"
else
  echo "    Kein config-Ordner — nichts zu sichern (frische Installation)."
fi

# --- 3) Neuen Stand holen ----------------------------------------------------
say "2/4  Neuen Stand holen"
git pull --ff-only
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    Bereits aktuell ($AFTER). Es wird trotzdem neu gebaut."
else
  echo "    $BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'
fi

# --- 4) Bauen und starten ----------------------------------------------------
say "3/4  Neu bauen"
docker compose build

say "4/4  Dienste durchstarten"
docker compose up -d

sleep 5
docker compose ps
say "Fertig. Bei Problemen:  docker compose logs -f app"

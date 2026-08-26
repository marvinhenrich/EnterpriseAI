#!/usr/bin/env bash
# =============================================================================
# Zusatzdienste einrichten: Texterkennung, Eigenschaftsvorhersage,
# Bildgenerierung.
#
#   ./services/setup.sh          # einrichten
#   ./services/setup.sh start    # beide Dienste im Vordergrund starten
#
# Beide Dienste hören ausschließlich auf 127.0.0.1 und rufen nichts nach außen.
# Sie sind optional: Sind die zugehörigen Module abgeschaltet, braucht es sie
# nicht — das Hauptprogramm läuft ohne sie unverändert.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

VENV="${VENV:-./venv}"
blau()  { printf '\033[34m%s\033[0m\n' "$1"; }
gruen() { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$1"; }

starten() {
  [ -x "$VENV/bin/python" ] || { warn "Noch nicht eingerichtet — erst ./services/setup.sh aufrufen."; exit 1; }
  blau "Dienste starten"
  "$VENV/bin/python" classifier/server.py &
  local ocr=$!
  "$VENV/bin/python" imagegen/server.py &
  local img=$!
  trap 'kill $ocr $img 2>/dev/null || true' INT TERM
  gruen "Texterkennung   → http://127.0.0.1:7871"
  gruen "Bildgenerierung → http://127.0.0.1:7870"
  wait
}

[ "${1:-}" = "start" ] && starten

blau "Python prüfen"
command -v python3 >/dev/null || { warn "python3 fehlt — https://python.org"; exit 1; }
gruen "$(python3 --version)"

blau "Umgebung anlegen"
[ -d "$VENV" ] || python3 -m venv "$VENV"
gruen "$VENV"

blau "Pakete installieren (das dauert beim ersten Mal einige Minuten)"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r requirements.txt
gruen "fertig"

# mflux gibt es nur für Apple Silicon — dort automatisch mitinstallieren.
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  blau "Bildgenerierung (Apple Silicon)"
  "$VENV/bin/pip" install --quiet mflux 2>/dev/null && gruen "mflux" || warn "mflux nicht verfügbar — Modul „Bildgenerierung\" im Adminbereich abschalten"
else
  warn "Bildgenerierung braucht Apple Silicon — Modul im Adminbereich abschalten"
fi

echo
blau "Bereit"
echo "  Starten:  ./services/setup.sh start"
echo
echo "  Für den Dauerbetrieb gehören die Dienste unter die Prozessverwaltung des"
echo "  Betriebssystems (launchd, systemd) — die Einrichtung dafür ist"
echo "  installationsspezifisch und liegt außerhalb dieses Verzeichnisses."

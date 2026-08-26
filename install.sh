#!/usr/bin/env bash
# =============================================================================
# Einrichtung ohne Container — für macOS und Linux.
#
#   ./install.sh
#
# Legt den Konfigurationsordner an, erzeugt Zufallsgeheimnisse und prüft die
# Voraussetzungen. Fasst nichts an, was schon existiert.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

blau()  { printf '\033[34m%s\033[0m\n' "$1"; }
gruen() { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$1"; }
fehler(){ printf '\033[31m  ✗ %s\033[0m\n' "$1"; }

blau "Voraussetzungen"
command -v node >/dev/null || { fehler "Node.js fehlt — https://nodejs.org (Version 22 oder neuer)"; exit 1; }
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || { fehler "Node.js $NODE_MAJOR ist zu alt, benötigt wird 20 oder neuer"; exit 1; }
gruen "Node.js $(node -v)"
command -v npm >/dev/null || { fehler "npm fehlt"; exit 1; }
gruen "npm $(npm -v)"

if command -v ollama >/dev/null; then
  gruen "Ollama gefunden"
else
  warn "Ollama fehlt — https://ollama.com. Ohne Sprachmodell startet die Anwendung, kann aber nicht antworten."
fi

blau "Konfiguration"
CONFIG_DIR="${CONFIG_DIR:-$(cd .. && pwd)/config}"
mkdir -p "$CONFIG_DIR"/{assets,certs}
if [ -f "$CONFIG_DIR/.env" ]; then
  warn "$CONFIG_DIR/.env existiert bereits — unverändert gelassen"
else
  cp .env.example "$CONFIG_DIR/.env"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  # Portabel zwischen GNU und BSD sed.
  node -e "
    const fs=require('fs'),p='$CONFIG_DIR/.env';
    let s=fs.readFileSync(p,'utf8').replace(/^JWT_SECRET=.*\$/m,'JWT_SECRET=$SECRET');
    fs.writeFileSync(p,s);
  "
  gruen "$CONFIG_DIR/.env angelegt, Sicherheitsschlüssel erzeugt"
fi
echo "CONFIG_DIR=$CONFIG_DIR" > .env
gruen "Zeiger auf den Konfigurationsordner gesetzt"

blau "Abhängigkeiten"
npm ci --no-audit --fund=false >/dev/null 2>&1 || npm install --no-audit --fund=false >/dev/null
gruen "installiert"

blau "Anwendung bauen"
npm run build >/dev/null
gruen "gebaut"

# --- Sprachdaten der Texterkennung -------------------------------------------
# Rund 37 MB, deshalb nicht im Verzeichnis mitgeliefert. Der Betrieb selbst
# bleibt offline: tesseract.js liest die Dateien nur von der Platte.
blau "Sprachdaten für die Texterkennung"
OCR_DIR="apps/server/ocr-data"
mkdir -p "$OCR_DIR"
TESSDATA="https://github.com/tesseract-ocr/tessdata_fast/raw/main"
for lang in deu eng; do
  if [ -s "$OCR_DIR/$lang.traineddata" ] || [ -s "$OCR_DIR/$lang.traineddata.gz" ]; then
    gruen "$lang bereits vorhanden"
  elif command -v curl >/dev/null && curl -fsSL "$TESSDATA/$lang.traineddata" -o "$OCR_DIR/$lang.traineddata" 2>/dev/null; then
    gruen "$lang geladen"
  else
    rm -f "$OCR_DIR/$lang.traineddata"
    warn "$lang nicht ladbar — Datei von Hand nach $OCR_DIR/ kopieren oder Modul „Texterkennung\" abschalten"
  fi
done

blau "Datenbank"
npm run db:migrate >/dev/null 2>&1 && gruen "Migrationen angewendet" || warn "Migration fehlgeschlagen — später: npm run db:migrate"

echo
blau "Fertig."
echo "  1. Konfiguration prüfen:  \$EDITOR $CONFIG_DIR/.env"
echo "  2. Sprachmodell laden:    ollama pull gpt-oss:120b   (oder ein kleineres)"
echo "  3. Starten:               npm start"
echo
echo "  Logo hinterlegen (freiwillig):  $CONFIG_DIR/assets/logo.png"

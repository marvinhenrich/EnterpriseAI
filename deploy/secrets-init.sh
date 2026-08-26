#!/bin/sh
# Erzeugt beim allerersten Start, was diese Installation braucht.
#
# WARUM ein eigener Container dafür:
# Docker Compose liest die Datei .env, BEVOR irgendein Container läuft. Ein
# Skript, das vorher Geheimnisse erzeugt, müsste der Anwender selbst starten —
# genau das soll entfallen. Deshalb legt dieser Container die Werte im
# Konfigurationsordner ab, bevor die Anwendung startet.
#
# Ergebnis: `docker compose up -d` genügt, und trotzdem hat JEDE Installation
# ihren eigenen, zufälligen Sicherheitsschlüssel — kein ausgeliefertes
# Standardgeheimnis, das im Internet steht.
set -e

DIR="${CONFIG_DIR:-/config}"
mkdir -p "$DIR/assets" "$DIR/certs" "$DIR/data"

if [ -s "$DIR/.env" ]; then
  echo "[init] $DIR/.env ist vorhanden und bleibt unverändert."
else
  # 48 Byte Zufall aus dem Betriebssystem, hexadezimal — keine Sonderzeichen,
  # damit der Wert in jeder Umgebung unfallfrei durchgereicht wird.
  SECRET="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$DIR/.env" <<EOF
# Automatisch erzeugt beim ersten Start.
# Weitere Einstellungen siehe .env.example im Projektordner.
JWT_SECRET=$SECRET
EOF
  chmod 600 "$DIR/.env"
  echo "[init] $DIR/.env angelegt, Sicherheitsschlüssel erzeugt."
fi

# --- TLS ---------------------------------------------------------------------
# Die Anwendung liefert nach aussen ausschliesslich ueber HTTPS aus (HTTP bindet
# bewusst nur an Loopback). Ohne Zertifikat waere sie also von aussen gar nicht
# erreichbar - deshalb wird beim ersten Start eines erzeugt.
#
# Wer ein echtes Zertifikat hat, legt cert.pem und key.pem einfach in
# config/certs; dann wird nichts erzeugt.
CRT="$DIR/certs/cert.pem"
KEY="$DIR/certs/key.pem"
if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  CN="${PUBLIC_HOSTNAME:-enterpriseai.local}"
  command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null 2>&1
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CRT" -subj "/CN=$CN" \
    -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 600 "$KEY"
  echo "[init] Selbstsigniertes TLS-Zertifikat fuer '$CN' erzeugt (10 Jahre)."
else
  echo "[init] Vorhandenes TLS-Zertifikat wird verwendet."
fi

# Die Anwendung laeuft nicht als root (Benutzer 10001 im Abbild) und muss hier
# lesen UND schreiben: Datenbank, hochgeladene Dateien, Zertifikate.
chown -R 10001:10001 "$DIR" 2>/dev/null || true

echo "[init] Zum Sichern: den Ordner $DIR mitsichern — dort liegen Datenbank,"
echo "[init] hochgeladene Dateien und der Sicherheitsschlüssel."

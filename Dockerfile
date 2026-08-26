# =============================================================================
# EnterpriseAI — Container.
#
# Der Container enthält AUSSCHLIESSLICH das Programm. Konfiguration, Logo,
# Datenbank und hochgeladene Dateien liegen in einem eingehängten Ordner
# (/config). Damit lässt sich das Abbild aktualisieren, ohne Betriebsdaten
# anzufassen — und dasselbe Abbild in mehreren Betrieben einsetzen.
# =============================================================================

FROM node:22-slim AS build
WORKDIR /app

# Abhängigkeiten zuerst: ändert sich der Quelltext, bleibt diese Schicht gültig.
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
# Auch die Paketdatei des Servers: ohne sie installiert `npm ci` im Workspace
# dessen Abhaengigkeiten NICHT, und der Start scheitert an @hono/node-server.
COPY apps/server/package*.json ./apps/server/
RUN npm ci --no-audit --fund=false

COPY . .
RUN npm run build

# --- Laufzeit ----------------------------------------------------------------
FROM node:22-slim
WORKDIR /app

# Texterkennung (offline) und die Python-Umgebung für Vorhersagen.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
      python3 python3-venv python3-pip unzip \
 && rm -rf /var/lib/apt/lists/*

# tesseract.js sucht die Sprachdaten in apps/server/ocr-data; die Paketverwaltung
# legt sie woanders ab. Ohne diesen Schritt fände die Texterkennung nichts.
RUN mkdir -p /app/apps/server/ocr-data \
 && find /usr/share -name '[a-z][a-z][a-z].traineddata' -exec cp {} /app/apps/server/ocr-data/ \; \
 && ls /app/apps/server/ocr-data/

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package*.json ./

# Nicht als root laufen.
RUN useradd -r -u 10001 -m app && mkdir -p /config && chown -R app:app /app /config
USER app

# Hier liegt alles Installationsspezifische. Als Volume einhängen.
VOLUME ["/config"]
ENV CONFIG_DIR=/config \
    NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    # Datenbank in den eingehaengten Ordner, NICHT ins Abbild. Der Standard
    # './data/app.db' liegt relativ zum Arbeitsverzeichnis und waere damit Teil
    # des Containers - jedes Update haette alle Daten vernichtet.
    DATABASE_PATH=/config/data/app.db

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/server
# Migrationen VOR dem Start: eine frische Installation hat eine leere Datenbank,
# und der Server greift beim Hochfahren bereits auf Tabellen zu. Ohne diesen
# Schritt endet jeder erste Start in einem SQLITE_ERROR.
CMD ["sh", "-c", "node --import tsx src/db/migrate.ts && node --import tsx src/db/bootstrap-admin.ts && node --import tsx src/index.ts"]

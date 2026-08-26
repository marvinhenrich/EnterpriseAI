#!/usr/bin/env python3
"""
EnterpriseAI — lokaler OCR-Dienst (PyMuPDF + EasyOCR, mehrsprachig).

Zweck: Etikett-PDFs UND Bilder (Scans) auslesen — mehrsprachig (Deutsch, Englisch,
Serbisch kyrillisch/lateinisch, Chinesisch). Versorgt die geteilte Etiketten-DB.

STRIKT INTERN: bindet nur 127.0.0.1, läuft auf der CPU (kein GPU → keine Konkurrenz
mit dem Chat-Modell). Modelle liegen lokal in ~/.EasyOCR (offline zur Laufzeit).

Endpoints:
  GET  /health
  POST /ocr {pdf_base64|data_base64, groups[], kind}  → {text, pages, truncated}
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("CLS_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLS_PORT", "7871"))

# Bild-PDF → Seitenbilder (PyMuPDF) → mehrsprachige OCR (EasyOCR, CPU).
# EasyOCR kann nicht alle Schriften in EINEM Reader laden → Sprachgruppen.
OCR_GROUPS = {
    "latin": ["de", "en", "rs_latin"],   # Deutsch / Englisch / Serbisch (lat.)
    "cyrillic": ["rs_cyrillic", "en"],   # Serbisch (kyrillisch)
    "chinese": ["ch_sim", "en"],         # Chinesisch (vereinfacht)
    "chinese_tra": ["ch_tra", "en"],     # Chinesisch (traditionell)
}
OCR_DPI = int(os.environ.get("OCR_DPI", "200"))
OCR_MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "10"))
_readers = {}
_ocr_lock = threading.Lock()  # OCR (CPU/torch) serialisieren


def get_reader(group):
    if group not in OCR_GROUPS:
        raise ValueError(f"Unbekannte Sprachgruppe: {group}")
    if group not in _readers:
        t0 = time.time()
        print(f"[ocr] lade EasyOCR-Reader '{group}' {OCR_GROUPS[group]} (CPU) …", flush=True)
        import easyocr
        _readers[group] = easyocr.Reader(OCR_GROUPS[group], gpu=False, verbose=False)
        print(f"[ocr] Reader '{group}' bereit in {time.time() - t0:.1f}s", flush=True)
    return _readers[group]


def ocr_bytes(data, groups, kind="pdf"):
    """PDF ODER Bild → Text (Union über alle angeforderten Sprachgruppen)."""
    import numpy as np
    groups = [g for g in (groups or ["latin"]) if g in OCR_GROUPS] or ["latin"]
    images = []
    truncated = False
    if kind == "image":
        import io
        from PIL import Image
        images = [np.array(Image.open(io.BytesIO(data)).convert("RGB"))]
    else:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        n = min(len(doc), OCR_MAX_PAGES)
        truncated = len(doc) > n
        for i in range(n):
            pix = doc[i].get_pixmap(dpi=OCR_DPI)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            images.append(arr[:, :, :3])
    import easyocr.utils
    page_texts = []
    with _ocr_lock:
        for pidx, img in enumerate(images):
            parts = []
            try:
                # Texterkennung (CRAFT, sprachunabhängig) NUR EINMAL, dann je Sprache
                # nur noch erkennen → ~2,3× schneller bei gleicher Trefferquote.
                grey = np.array(easyocr.utils.reformat_input(img)[1])
                h, f = get_reader(groups[0]).detect(grey)
                h0 = h[0] if h else []
                f0 = f[0] if f else []
                for g in groups:
                    parts.extend(get_reader(g).recognize(grey, h0, f0, detail=0, paragraph=True))
            except Exception as e:  # noqa: BLE001 — robuster Fallback: klassisch je Gruppe
                print(f"[ocr] detect/recognize-Fallback Seite {pidx+1}: {e}", file=sys.stderr, flush=True)
                parts = []
                for g in groups:
                    try:
                        parts.extend(get_reader(g).readtext(img, detail=0, paragraph=True))
                    except Exception as e2:  # noqa: BLE001
                        print(f"[ocr] Gruppe '{g}' Fehler: {e2}", file=sys.stderr, flush=True)
            page_texts.append(" ".join(parts))
    return {"text": "\n".join(page_texts), "pages": len(images), "truncated": truncated}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz", ""):
            self._send(200, {"status": "ok", "service": "ocr", "groups": list(OCR_GROUPS), "loaded": list(_readers)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/ocr":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "ungültiges JSON"})
            return
        try:
            import base64
            b64 = payload.get("pdf_base64") or payload.get("data_base64") or ""
            if not b64:
                raise ValueError("pdf_base64/data_base64 erforderlich")
            self._send(200, ocr_bytes(base64.b64decode(b64), payload.get("groups"), payload.get("kind", "pdf")))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            print(f"[ocr] Fehler: {e}", file=sys.stderr, flush=True)
            self._send(500, {"error": f"OCR fehlgeschlagen: {e}"})


def main():
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"[ocr] VERWEIGERT: HOST={HOST} ist nicht localhost.", file=sys.stderr)
        sys.exit(2)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[ocr] bereit auf http://{HOST}:{PORT} (Reader lazy)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

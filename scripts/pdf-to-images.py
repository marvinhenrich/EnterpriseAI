#!/usr/bin/env python3
"""
Rendert PDF-Seiten als PNG — Vorstufe für die Texterkennung bei Scans.

Wird vom Server aufgerufen (lib/ocr.ts). Nutzt PyMuPDF aus der vorhandenen
ML-Umgebung; keine zusätzliche Abhängigkeit, kein Netzzugriff.

Aufruf:  pdf-to-images.py <pdf> <zielordner> [max_seiten] [dpi]
Ausgabe: je Zeile ein erzeugter Dateipfad.
"""
import sys, os

def main() -> int:
    if len(sys.argv) < 3:
        print("Aufruf: pdf-to-images.py <pdf> <zielordner> [max_seiten] [dpi]", file=sys.stderr)
        return 2
    pdf, out = sys.argv[1], sys.argv[2]
    max_seiten = int(sys.argv[3]) if len(sys.argv) > 3 else 15
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 200

    import fitz  # PyMuPDF

    os.makedirs(out, exist_ok=True)
    doc = fitz.open(pdf)
    for i, seite in enumerate(doc):
        if i >= max_seiten:
            break
        ziel = os.path.join(out, f"seite-{i + 1:03d}.png")
        seite.get_pixmap(dpi=dpi).save(ziel)
        print(ziel, flush=True)
    doc.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())

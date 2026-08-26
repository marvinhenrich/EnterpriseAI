#!/usr/bin/env python3
"""Altes Binär-Excel (.xls, BIFF) in Text wandeln.

ExcelJS liest nur die ZIP-basierten .xlsx-Dateien. Das alte OLE-Format kommt in
einem Betrieb mit gewachsenem Datenbestand aber laufend vor, und Tabellen sind
gerade in der Fachanwendung die interessanteren Dateien.

Aufruf: xls-to-text.py <datei.xls> [max_zeilen_je_blatt]
Ausgabe: Text auf stdout, ein Blatt je Abschnitt, Spalten tabgetrennt.
"""

import sys

import xlrd


def zelle(wert, typ, datemode):
    """Zellwert als Text. Zahlen ohne Nachkommastellen bleiben ganzzahlig."""
    if typ == xlrd.XL_CELL_EMPTY or wert is None:
        return ''
    if typ == xlrd.XL_CELL_DATE:
        try:
            j, m, t, hh, mm, ss = xlrd.xldate_as_tuple(wert, datemode)
            return f'{t:02d}.{m:02d}.{j:04d}' if not (hh or mm or ss) else f'{t:02d}.{m:02d}.{j:04d} {hh:02d}:{mm:02d}'
        except Exception:
            return str(wert)
    if typ == xlrd.XL_CELL_BOOLEAN:
        return 'WAHR' if wert else 'FALSCH'
    if typ == xlrd.XL_CELL_NUMBER:
        return str(int(wert)) if float(wert).is_integer() else str(wert)
    return str(wert).replace('\t', ' ').replace('\n', ' ').strip()


def main():
    if len(sys.argv) < 2:
        print('Aufruf: xls-to-text.py <datei.xls> [max_zeilen]', file=sys.stderr)
        return 2
    pfad = sys.argv[1]
    max_zeilen = int(sys.argv[2]) if len(sys.argv) > 2 else 20000

    mappe = xlrd.open_workbook(pfad, formatting_info=False, on_demand=True)
    ausgabe = []
    for name in mappe.sheet_names():
        blatt = mappe.sheet_by_name(name)
        if blatt.nrows == 0:
            continue
        ausgabe.append(f'# Tabelle: {name}')
        grenze = min(blatt.nrows, max_zeilen)
        for r in range(grenze):
            werte = [
                zelle(blatt.cell_value(r, c), blatt.cell_type(r, c), mappe.datemode)
                for c in range(blatt.ncols)
            ]
            # Leerzeilen weglassen — sie blähen den Kontext nur auf.
            if any(w for w in werte):
                ausgabe.append('\t'.join(werte).rstrip('\t'))
        if blatt.nrows > grenze:
            ausgabe.append(f'# … {blatt.nrows - grenze} weitere Zeilen abgeschnitten')
        mappe.unload_sheet(name)

    sys.stdout.write('\n'.join(ausgabe))
    return 0


if __name__ == '__main__':
    sys.exit(main())

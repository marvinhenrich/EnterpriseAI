#!/usr/bin/env python3
"""Modellvergleich an echten Fachfragen aus Entwicklung & Forschung.

Laeuft gegen JEDEN Endpunkt, der die Ollama- oder die OpenAI-Chat-Schnittstelle
spricht. Damit laesst sich ein gemietetes Modell in einer Stunde gegen das
lokale messen — statt darueber zu diskutieren.

Bewertet wird mechanisch nach Stichworten. Das ist grob, aber es ist fuer alle
Modelle GLEICH grob, und genau darauf kommt es beim Vergleich an.

  MUSS-Begriffe: fehlt einer, ist die Antwort fachlich unvollstaendig.
  SOLL-Begriffe: Tiefe der Antwort.

Aufrufe:
  vergleich.py --ollama http://localhost:11434 --modell gpt-oss:120b --think medium
  vergleich.py --openai https://<endpunkt>/v1 --modell deepseek-v3.1 --key $API_KEY
  vergleich.py --datei antworten.json          (fertige Antworten bewerten)
"""

import argparse
import json
import os
import sys
import time
import urllib.request

HIER = os.path.dirname(os.path.abspath(__file__))

SYSTEM = (
    "Du bist Entwicklungsassistenz einer Lackfabrik fuer wasserbasierte Bautenanstrichmittel. "
    "Antworte fachlich praezise und knapp. Keine Floskeln, keine Wiederholung der Frage."
)


def hole(url, koerper, kopf=None, timeout=900):
    req = urllib.request.Request(url, json.dumps(koerper).encode(),
                                 {'Content-Type': 'application/json', **(kopf or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def frage_ollama(basis, modell, denken, frage):
    d = hole(f'{basis}/api/chat', {
        'model': modell, 'stream': False, 'keep_alive': '24h',
        'think': denken if denken != 'off' else False,
        'options': {'num_ctx': 32768, 'num_predict': 3000, 'temperature': 0.15},
        'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': frage}],
    })
    m = d.get('message', {})
    return (m.get('content') or ''), (m.get('thinking') or ''), d.get('eval_count', 0)


def frage_openai(basis, modell, key, frage):
    d = hole(f'{basis}/chat/completions', {
        'model': modell, 'temperature': 0.15, 'max_tokens': 3000,
        'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': frage}],
    }, {'Authorization': f'Bearer {key}'} if key else None)
    w = d['choices'][0]['message']
    return (w.get('content') or ''), (w.get('reasoning_content') or ''), d.get('usage', {}).get('completion_tokens', 0)


def bewerte(text, f):
    t = text.lower()
    muss = [w for w in f['muss'] if w in t]
    soll = [w for w in f['soll'] if w in t]
    # MUSS zaehlt doppelt: eine Antwort ohne den Kernbegriff ist fachlich falsch,
    # auch wenn sie viele Randbegriffe streift.
    punkte = 2 * len(muss) + len(soll)
    max_p = 2 * len(f['muss']) + len(f['soll'])
    return punkte, max_p, len(muss), len(f['muss']), soll


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--ollama')
    p.add_argument('--openai')
    p.add_argument('--datei')
    p.add_argument('--modell', default='gpt-oss:120b')
    p.add_argument('--key', default=os.environ.get('BENCH_API_KEY', ''))
    p.add_argument('--think', default='medium', choices=['off', 'low', 'medium', 'high'])
    p.add_argument('--speichern')
    a = p.parse_args()

    daten = json.load(open(os.path.join(HIER, 'fragen.json'), encoding='utf-8'))
    fertige = json.load(open(a.datei, encoding='utf-8')) if a.datei else None

    ges_p = ges_m = 0
    ges_muss = ges_muss_max = 0
    ges_zeit = 0.0
    antworten = {}

    print('Ziel: %s' % (a.datei or a.openai or a.ollama or '?'))
    print('Modell: %s%s\n' % (a.modell, '' if a.datei or a.openai else f'  (think={a.think})'))
    print('%-20s %7s %7s %9s  %s' % ('Frage', 'Punkte', 'MUSS', 'Sekunden', 'fehlende MUSS-Begriffe'))
    print('-' * 92)

    for f in daten['fragen']:
        t0 = time.time()
        if fertige is not None:
            txt, denk, tok = fertige.get(f['id'], ''), '', 0
        elif a.openai:
            txt, denk, tok = frage_openai(a.openai, a.modell, a.key, f['frage'])
        else:
            txt, denk, tok = frage_ollama(a.ollama or 'http://localhost:11434', a.modell, a.think, f['frage'])
        s = time.time() - t0
        antworten[f['id']] = txt
        # Denkspur mitbewerten: dort steht bei manchen Modellen der Fachinhalt.
        pkt, mx, mu, mu_max, soll = bewerte(txt + ' ' + denk, f)
        ges_p += pkt; ges_m += mx; ges_muss += mu; ges_muss_max += mu_max; ges_zeit += s
        fehlt = [w for w in f['muss'] if w not in (txt + ' ' + denk).lower()]
        print('%-20s %3d/%-3d %3d/%-3d %8.1f  %s' % (f['id'], pkt, mx, mu, mu_max, s, ', '.join(fehlt) or '—'))

    print('-' * 92)
    print('GESAMT               %3d/%-3d %3d/%-3d %8.1f' % (ges_p, ges_m, ges_muss, ges_muss_max, ges_zeit))
    print()
    print('  Fachpunkte      : %.0f %%' % (ges_p / ges_m * 100))
    print('  Kernbegriffe    : %.0f %%  <- entscheidend; darunter ist die Antwort fachlich unvollstaendig' % (ges_muss / ges_muss_max * 100))
    print('  Zeit gesamt     : %.1f s  (%.1f s je Frage)' % (ges_zeit, ges_zeit / len(daten['fragen'])))

    if a.speichern:
        json.dump(antworten, open(a.speichern, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('\n  Antworten gespeichert: %s' % a.speichern)


if __name__ == '__main__':
    sys.exit(main())

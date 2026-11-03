#!/usr/bin/env python3
"""Convierte la carpeta del plan (semanas/días/archivos .zwo) en src/plan.js para la app.
Uso: python3 -I tools/plan_from_zwo.py <carpeta_del_plan> <salida.js>"""
import json, re, sys, pathlib, xml.etree.ElementTree as ET

DAYS = {'martes': 'Martes', 'miercoles': 'Miércoles', 'miércoles': 'Miércoles', 'jueves': 'Jueves', 'domingo': 'Domingo',
        'lunes': 'Lunes', 'viernes': 'Viernes', 'sabado': 'Sábado', 'sábado': 'Sábado'}
ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

def num(el, *names):
    for n in names:
        for k in (n, n.lower()):
            v = el.get(k)
            if v not in (None, ''):
                return float(v)
    return None

def steps_of(root):
    out = []
    wk = root.find('workout')
    for el in list(wk):
        tag, dur = el.tag.lower(), num(el, 'Duration') or 0
        if tag in ('warmup', 'cooldown', 'ramp'):
            lo, hi = num(el, 'PowerLow'), num(el, 'PowerHigh')
            out.append({'dur': dur, 'p1': lo if lo is not None else .5, 'p2': hi if hi is not None else .5})
        elif tag in ('steadystate', 'solidstate'):
            p = num(el, 'Power')
            if p is None:
                lo, hi = num(el, 'PowerLow'), num(el, 'PowerHigh'); p = (lo + hi) / 2 if lo is not None and hi is not None else .6
            out.append({'dur': dur, 'p1': p, 'p2': p})
        elif tag == 'intervalst':
            n = int(num(el, 'Repeat') or 1)
            on, off = num(el, 'OnDuration') or 0, num(el, 'OffDuration') or 0
            pon = next(v for v in (num(el, 'OnPower'), num(el, 'PowerOnHigh'), num(el, 'PowerOnLow'), 1) if v is not None)
            poff = next(v for v in (num(el, 'OffPower'), num(el, 'PowerOffLow'), num(el, 'PowerOffHigh'), .5) if v is not None)
            out.append({'rep': n, 'block': [{'dur': on, 'p1': pon, 'p2': pon}, {'dur': off, 'p1': poff, 'p2': poff}]})
        elif tag in ('freeride', 'maxeffort'):
            out.append({'dur': dur, 'free': True})
    return out

def day_of(name):
    s = re.sub(r'^\d+\.?', '', name)
    key, _, extra = s.partition('_')
    return DAYS.get(key.lower(), key), extra

def nice_week(label):
    return label.replace('_', ' ').replace('Anaerobico', 'Anaeróbico')

root = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
weeks = []
for wdir in sorted([p for p in root.iterdir() if p.is_dir()], key=lambda p: int(p.name.split('_')[0])):
    n, _, label = wdir.name.partition('_')
    days = {}
    def add(day, extra, f=None):
        d = days.setdefault(day, {'day': day, 'note': '', 'workouts': []})
        if extra and re.search(r'max\s*(\d+)\s*_?bpm', extra, re.I):
            d['note'] = 'Rodaje libre · máx. ' + re.search(r'(\d+)', extra).group(1) + ' ppm'
        if f is not None:
            x = ET.parse(f).getroot()
            name = (x.findtext('name') or f.stem).strip()
            d['workouts'].append({'id': f'p{n}-{day[:3].lower()}-{len(d["workouts"])}', 'name': name, 'steps': steps_of(x)})
    for ddir in [p for p in wdir.iterdir() if p.is_dir()]:
        day, extra = day_of(ddir.name)
        add(day, extra)
        for f in sorted(ddir.glob('*.zwo')):
            add(day, extra, f)
    for f in sorted(wdir.glob('*.zwo')):  # sueltos en la semana: el día va en el nombre
        day = next((v for k, v in DAYS.items() if k in f.stem.lower()), 'Otros')
        add(day, '', f)
    dl = sorted(days.values(), key=lambda d: ORDER.index(d['day']) if d['day'] in ORDER else 99)
    weeks.append({'n': int(n), 'name': nice_week(label), 'days': dl})

js = "'use strict';\n/* Plan de entrenamiento de Fernando, generado con tools/plan_from_zwo.py a partir de sus .zwo */\nwindow.R = window.R || {};\nR.PLAN = " + json.dumps({'name': 'Mi plan', 'weeks': weeks}, ensure_ascii=False, separators=(',', ':')) + ";\n"
out.write_text(js)
total = sum(len(d['workouts']) for w in weeks for d in w['days'])
print(f'{len(weeks)} semanas, {total} entrenamientos')
for w in weeks:
    print(f"  S{w['n']} {w['name']}: " + ' | '.join(f"{d['day']}: " + (', '.join(x['name'] for x in d['workouts']) or d['note'] or '(vacío)') for d in w['days']))

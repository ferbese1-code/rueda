#!/usr/bin/env python3
"""Empaqueta Rueda en un único index.html (para GitHub Pages) y en una versión para vista previa."""
import pathlib, shutil

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "dist"  # vista previa (no se publica)
OUT.mkdir(exist_ok=True)

THREE = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Saira+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Saira:wght@400;500;600&display=swap">')
JS_ORDER = ["util.js", "ble.js", "routes.js", "sim.js", "world.js", "workouts.js", "data.js", "app.js"]

css = (SRC / "styles.css").read_text()
body = (SRC / "body.html").read_text()
js = "\n".join((SRC / f).read_text() for f in JS_ORDER)
title = "Rueda Virtual"

hosted = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="Rodillo virtual para Tacx con entrenamientos ERG y subida a Strava">
<meta name="theme-color" content="#0d1319">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-192.png">
{FONTS}
<style>
{css}
</style>
</head>
<body>
{body}
{THREE}
<script>
{js}
</script>
</body>
</html>
"""
(ROOT / "index.html").write_text(hosted)  # lo que sirve GitHub Pages

preview = f"""<title>{title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
{FONTS}
<style>
{css}
</style>
{body}
{THREE}
<script>
{js}
</script>
"""
(OUT / "preview.html").write_text(preview)

for f in (ROOT / "public").iterdir():
    shutil.copy(f, ROOT / f.name)
print("OK", len(hosted) // 1024, "KB")

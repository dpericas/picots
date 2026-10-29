#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Converteix els documents generals (Markdown) a PDF a docs/pdf/.

Cal: python3-markdown (Debian: apt install python3-markdown) i Google Chrome o Chromium.
Ús: python3 scripts/make-docs-pdf.py [--chrome=ruta]
Compatible amb Python 3.7+.
"""

import datetime
import os
import re
import shutil
import subprocess
import sys
import tempfile

import markdown

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'docs', 'pdf')

# (fitxer d'origen, nom del PDF)
DOCS = [
    ('docs/contingut/instruccions-families.md', 'instruccions-families.pdf'),
    ('docs/contingut/instruccions-professors.md', 'instruccions-professors.pdf'),
    ('docs/contingut/guio-conte.md', 'guio-conte.pdf'),
    ('docs/contingut/preguntes-questionari.md', 'preguntes-questionari.pdf'),
    ('docs/contingut/mencions-idees.md', 'mencions-idees.pdf'),
    ('docs/contingut/README.md', 'calendari-i-contingut.pdf'),
    ('docs/Prova-Windows.md', 'prova-windows.pdf'),
]

STYLE = """
@page { size: A4; margin: 16mm 16mm 18mm 16mm; }
body { font-family: "DejaVu Sans", "Segoe UI", Arial, sans-serif; color: #1d2433; font-size: 10.5pt; line-height: 1.5; }
h1 { font-size: 20pt; margin: 0 0 10px; border-bottom: 3px solid #ffcc33; padding-bottom: 6px; }
h2 { font-size: 13.5pt; margin: 20px 0 6px; color: #2b2350; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14px 0 4px; break-after: avoid; }
p { margin: 6px 0; }
ul, ol { margin: 6px 0; padding-left: 20px; }
li { margin: 2px 0; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9.5pt; }
tr { break-inside: avoid; }
th { background: #f3f4f7; text-align: left; padding: 5px 7px; border: 1px solid #e3e6ec; }
td { padding: 5px 7px; border: 1px solid #e3e6ec; vertical-align: top; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: 9pt; background: #f3f4f7; padding: 0 3px; border-radius: 3px; }
pre { background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 6px; padding: 8px 10px; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 8px 0; padding: 6px 12px; border-left: 4px solid #ffcc33; background: #fff8e1; }
hr { border: 0; border-top: 1px solid #e3e6ec; margin: 18px 0; }
.foot { margin-top: 24px; color: #8b93a7; font-size: 8pt; border-top: 1px solid #e3e6ec; padding-top: 4px; }
"""


def find_chrome():
    for arg in sys.argv[1:]:
        if arg.startswith('--chrome='):
            return arg.split('=', 1)[1]
    for name in ('google-chrome', 'chromium', 'chromium-browser', 'chrome'):
        path = shutil.which(name)
        if path:
            return path
    return None


INTERNAL = '<!-- intern'


def to_html(md_text, title):
    # Les notes internes (per a qui munta l'espectacle) no surten al PDF que s'envia.
    if INTERNAL in md_text:
        md_text = md_text[:md_text.index(INTERNAL)]
    # Els enllaços entre documents apunten als PDF.
    md_text = re.sub(r'\]\(([\w-]+)\.md\)', lambda m: '](' + m.group(1) + '.pdf)', md_text)
    body = markdown.markdown(md_text, extensions=['tables', 'fenced_code', 'sane_lists'])
    today = datetime.date.today().strftime('%d/%m/%Y')
    return ('<!doctype html><html lang="ca"><head><meta charset="utf-8"><title>' + title + '</title>'
            '<style>' + STYLE + '</style></head><body>' + body +
            '<div class="foot">Gala Picots 2027 · ' + title + ' · ' + today + '</div></body></html>')


def main():
    chrome = find_chrome()
    if not chrome:
        sys.stderr.write('No es troba Chrome ni Chromium. Indica\'l amb --chrome=ruta.\n')
        return 1
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    tmp = tempfile.mkdtemp(prefix='gala-docs-')
    made = 0
    try:
        for src, name in DOCS:
            path = os.path.join(ROOT, src)
            if not os.path.exists(path):
                sys.stderr.write('Falta ' + src + '\n')
                continue
            with open(path, encoding='utf-8') as f:
                text = f.read()
            title = os.path.splitext(name)[0].replace('-', ' ').capitalize()
            html_path = os.path.join(tmp, os.path.splitext(name)[0] + '.html')
            with open(html_path, 'w', encoding='utf-8') as f:
                f.write(to_html(text, title))
            pdf_path = os.path.join(OUT, name)
            subprocess.check_call([
                chrome, '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
                '--user-data-dir=' + os.path.join(tmp, 'perfil'),
                '--print-to-pdf=' + pdf_path, 'file://' + html_path,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            made += 1
            print('PDF: ' + os.path.relpath(pdf_path, ROOT))
        # El pla del projecte ja és un PDF: se'n deixa una còpia a la mateixa carpeta.
        plan = os.path.join(ROOT, 'docs', 'Pla-Gala-Manager.pdf')
        if os.path.exists(plan):
            shutil.copyfile(plan, os.path.join(OUT, 'pla-gala-manager.pdf'))
            print('PDF: docs/pdf/pla-gala-manager.pdf (còpia)')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('Fets: ' + str(made) + ' a docs/pdf/')
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Import the standalone deck, sharing its existing engine with the landing page."""
import argparse
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / 'research/paper/affine-plank/complexity-and-beauty/index.html'
ASSETS = ROOT / 'r/plank-viz'
SOURCES = (
    'widgets/vendor/bireactive/bireactive.js',
    'widgets/geometry.js',
    'widgets/plank-widgets.js',
)


def extract(page, tag, source):
    pattern = rf'^[ \t]*<{tag} data-source="{re.escape(source)}">\n(.*?)\n</{tag}>'
    matches = list(re.finditer(pattern, page, re.S | re.M))
    if len(matches) != 1:
        raise ValueError(f'Expected one inline {source}; use a standalone export')
    return matches[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('standalone', type=Path)
    args = parser.parse_args()
    page = args.standalone.read_text()
    scripts = [extract(page, 'script', source) for source in SOURCES]
    style = extract(page, 'style', 'widgets/intro-planks.css')
    core = '// Shared by the landing page and presentation.\n'
    core += '// Extracted by tools/import-plank-presentation.py; original licenses follow.\n'
    core += '\n;\n'.join(match[1] for match in scripts)

    # Blocking scripts preserve the deck's initialization order. The artwork
    # script between these blocks only defines its SVG string.
    for index, match in enumerate(scripts):
        src = os.path.relpath(ASSETS / 'core.js', PAGE.parent)
        page = page.replace(match[0], f' <script src="{src}"></script>' if index == 0 else '', 1)
    href = os.path.relpath(ASSETS / 'intro-planks.css', PAGE.parent)
    page = page.replace(style[0], f' <link rel="stylesheet" href="{href}">', 1)

    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / 'core.js').write_text(core)
    (ASSETS / 'intro-planks.css').write_text(style[1])
    PAGE.write_text(page)
    print('Imported presentation with one shared plank engine and stylesheet.')


if __name__ == '__main__':
    main()

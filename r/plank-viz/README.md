# Landing-page plank controls

The landing page progressively enhances its existing SVG image with the same
plank model and controls as the presentation. `landing.js` supplies the page's
live width total, reset, and optional animation. The static image remains usable
when JavaScript or the SVG request is unavailable.

`core.js` contains the existing engine extracted from the presentation. Both
website pages load this one copy. It concatenates these unmodified sources
from `affine-plank/viz`:

- `widgets/vendor/bireactive/bireactive.js`
- `widgets/geometry.js`
- `widgets/plank-widgets.js`

`intro-planks.css` is also shared; `landing.css` adds page-specific sizing.
Bireactive 0.3.5 is by Orion Reed,
and its MIT license is included in `core.js`. These assets need no CDN or npm
dependencies. To import an updated presentation and refresh the shared assets:

```sh
python3 tools/import-plank-presentation.py /path/to/viz/docs/presentation-standalone.html
```

The importer moves the existing script and style bodies without changing them.
The source export remains self-contained for offline use; the website copy
references the shared files using relative paths.

To check a served landing-page preview, run:

```sh
node tools/check-plank-landing.mjs http://127.0.0.1:8841/
```

The check uses a local Chromium installation and Node's built-in WebSocket.
It exercises real pointer, touch, and keyboard input, live measurements,
animation, reset, both themes, responsive sizing, and the static fallback.

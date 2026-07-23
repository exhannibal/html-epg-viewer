# html-epg-viewer (fork)

Fork of [dbghelp/html-epg-viewer](https://github.com/dbghelp/html-epg-viewer) with a **Humax / Home Assistant** default.

## Humax on Home Assistant

Serve this folder next to your XMLTV cache under HA `www/epg/`:

| File | Role |
|------|------|
| `epg.html` | Viewer (defaults to `humax-epg.xml`) |
| `xml-epg.js` / `xml-epg.css` | Local copies (no github.io / CORS) |
| `humax-epg.xml` | Your Humax Freeview export |

Open (same origin → no CORS):

`http://homeassistant.local:8123/local/epg/epg.html`

Optional override:

`http://homeassistant.local:8123/local/epg/epg.html?file=humax-epg.xml.gz`

## Upstream usage

Still supports `?file=<url>` as upstream documents.

Demo pattern: https://dbghelp.github.io/epg.html?file=

## Changes in this fork

- Default EPG path: `humax-epg.xml` (relative)
- Bundle `xml-epg.js` / `xml-epg.css` locally (works under `/local/epg/`)
- Drop Shaka / M3U8 player deps (guide-only)
- Auto-open the all-channels timeline after load

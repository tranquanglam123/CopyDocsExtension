# CopyDocExt — architecture

MV3 extension. No bundler: import paths are real relative paths.

`test/architecture.test.js` enforces every rule below. Run `node --test test/*.test.js`.

## Realms

Chrome runs four isolated JS realms. They cannot call each other's functions —
only `chrome.runtime` messages cross the line.

| Folder | Realm | Entry | Has DOM | Dies when |
|---|---|---|---|---|
| `src/popup/` | popup page | `main.js` | yes | the popup closes |
| `src/background/` | service worker | `main.js` | no | idle, ~30s |
| `src/offscreen/` | offscreen document | `main.js` | yes | the worker closes it |
| `src/content/` | content script | `main.js` | the host page | the tab navigates |

`src/bridge/` and `src/lib/` are not realms. They are code the realms share.
`src/vendor/` is third-party code (pdf.js), copied unmodified as `.mjs`, so
the architecture tests never scan it. Upgrade it whole; never edit it.

## What each folder holds

- **`popup/`** — everything the popup needs. `view.js` writes DOM and decides
  nothing. `controller.js` decides and touches no DOM. `export.js` produces
  clipboard, `.docx` and `.txt` output. `docx.js` needs `DOMParser`, so it
  lives here rather than in `lib/`.
- **`background/`** — `main.js` registers listeners and nothing else.
  `check.js` answers CHECK_TAB. `extract/` holds the four backends, their
  transports and the watchdog.
- **`offscreen/`** — `main.js` hosts the sandbox iframe. `pass/` holds one
  extraction pass per file, each taking a document and returning data.
  `file/` holds one parser per file format (PDF via pdf.js, DOCX), each
  taking bytes and returning body HTML. The DOCX parser also returns the
  file's OLE objects, marked `data-ole` in the HTML, for `popup/docx.js`:
  MathType equations converted to Office Math (`lib/cfb.js` → `lib/mtef.js`
  → `lib/math-render.js`), anything else kept whole; `lib/const.js` holds
  the shared relationship-id placeholders.
- **`content/`** — `main.js` is readiness detection only and returns raw
  HTML. `scan.js` is injected on demand into a web page, lists its embeds
  and returns its HTML; like `main.js` it is a plain script, not a module.
- **`bridge/`** — the only code allowed to call `chrome.*`. `contract.js`
  declares every message name and payload. `chrome/` wraps one API per file.
- **`lib/`** — pure. No `chrome`, no `document`, no `window`. `node --test`
  exercises all of it.

## Import rules

```
popup      → bridge, lib
background → bridge, lib
offscreen  → bridge, lib
content    → (nothing — see below)
bridge     → lib
lib        → lib
```

Forbidden:

1. `chrome.` outside `src/bridge/`.
2. `document.`, `window.` or `DOMParser` in `background/`, `bridge/` or `lib/`.
3. One realm importing another. They meet through messages only.
4. `lib/` importing anything outside `lib/`.
5. `bridge/` importing a realm.
6. Anything importing a `main.js`. Entries are leaves.
7. An import path containing `../../..`.
8. A storage key, warning code or alarm name written outside `lib/const.js`.
9. A message name written outside `bridge/contract.js`.
10. `popup/view.js` calling `chrome.*` or importing `bridge/`;
    `popup/controller.js` querying the DOM.

Sizes: `background/main.js` and `offscreen/main.js` under 120 lines,
`content/main.js` under 100.

`content/main.js` is the one exemption to rules 1, 8 and 9: MV3 content
scripts are not ES modules, so it cannot import and must inline its literals.
`content/scan.js` needs no exemption: it uses no `chrome.*` and no shared
literal.

## Message flow

```
popup/controller.js ─► bridge/to-background.js ─► background/main.js
                                                      │
                                                      ▼
                                              background/extract/run.js
                                                      │
                          bridge/to-offscreen.js ◄────┤
                                   │                  │
                                   ▼                  ▼
                          offscreen/main.js    content/main.js
                                               content/scan.js (injected)
```

`bridge/contract.js` is the single list of message names and payload shapes.

## Backends

Four, picked by `background/extract/route.js` from the document type:

| File | Doc type | How |
|---|---|---|
| `via-fetch.js` | Docs | GET `/mobilebasic`, parse in `offscreen/` |
| `via-csv.js` | Sheets | GET the `gviz` CSV, convert in `lib/csv.js` |
| `via-embed.js` | web | scan the tab via `content/scan.js`, classify in `lib/embed.js`, fetch each file and parse in `offscreen/file/`; else the page article |
| `via-tabnav.js` | fallback | block JS, navigate the tab, scrape via `content/` |

`via-embed.js` reuses the other backends for a Google Doc or Sheet embedded
in a page. Every other http(s) URL is `web`.

Transports: `http.js` tries swFetch then csFetch. `binary.js` fetches image
bytes for `image.js`, and whole files for `via-embed.js` — in the tab first
when same-origin, from the worker first otherwise. A cross-origin file needs
its host granted: the popup requests the `origins` CHECK_TAB returned, from
the Extract click, against `optional_host_permissions`.

Slides has no working server-rendered path. `route.js` returns `null` for it.

## Comments

One or two lines, saying why the code is the way it is. No references to
documents outside this repo.

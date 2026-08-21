# CopyDocExt

Vietnamese: [README.vi.md](README.vi.md)

A Chrome extension that extracts content from Google Docs and Sheets with
copy/download restricted, so you can read, paste, or save documents you
already have access to.

## How it works

CopyDocExt fetches the document's `/mobilebasic` page (Docs) or CSV export
(Sheets) directly, using your own logged-in Google session — the same
request your browser already makes, just not through the blocked File >
Download menu. No tab navigation, no disabling JavaScript. Only if every
fetch fails does it fall back to the old tab-navigation method, which
currently fails on most documents: Google redirects a script-blocked tab to a cookie-help page instead.

## Install

There is no installer — load the source directly, in developer mode:

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked**, select the folder containing `manifest.json`.
4. If the icon isn't visible, pin it from the puzzle-piece menu.

## Use

1. Open a restricted Google Doc or Sheet, click the icon, then **Extract Content**.
2. Export the result:
   - **Copy** — formatted HTML to the clipboard, for Docs, Word, or any
     rich text editor.
   - **New Doc** — copies content, opens a blank Google Doc; press Ctrl+V.
   - **.docx** — a Word document with formatting; images not included
     yet, use Copy or New Doc for those.
   - **.txt** — plain text.

If the popup closes mid-extraction, click the icon again — the result is still there. The footer switches the interface between English and Vietnamese.

## Limits

Properties of the source document, not shortcuts in the extension:
- Equations and drawings are already rendered as pictures in Google's own
  HTML, so they arrive as images, not editable text or equations — and
  text drawn inside a picture cannot be recovered as selectable text.
- Only the first sheet of a spreadsheet is read.
- Google Slides is not supported — no reliable server-rendered path
  exists for it yet.

## Troubleshooting

| Problem | Cause |
|---|---|
| "Not a Google Doc" | Current tab isn't a `docs.google.com` document or sheet. |
| Extraction fails after a long wait | Fetch failed and it fell back to tab navigation, which Google blocks on most documents. |
| .docx has no images | Expected for now — use Copy or New Doc instead. |

## Privacy

CopyDocExt sends nothing anywhere. It fetches from `docs.google.com` using
your own existing session, the same access your browser already has.
Parsing, formatting, and file generation all happen locally — no telemetry, no third-party server.

## Project structure

```
manifest.json
src/
  entry/       background, content script, popup, offscreen — wiring only
  extraction/  fetch pipelines, transports, image embedding
  platform/    the only layer that calls chrome.* APIs
  core/        pure logic — URL parsing, sanitizing, CSV/zip helpers
  ui/          popup view, controller, export handlers, docx generator
  shared/      constants used across layers
```

## License

MIT — see [LICENSE](LICENSE).

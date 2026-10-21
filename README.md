# CopyDocExt

Vietnamese: [README.vi.md](README.vi.md)

A Chrome extension that extracts content from Google Docs and Sheets with
copy/download restricted, and the learning material other web pages embed
(PDF and Word files behind a viewer), so you can read, paste, or save
documents you already have access to.

## How it works

CopyDocExt fetches the document's `/mobilebasic` page (Docs) or CSV export
(Sheets) directly, using your own logged-in Google session — the same
request your browser already makes, just not through the blocked File >
Download menu. No tab navigation, no disabling JavaScript. Only if every
fetch fails does it fall back to the old tab-navigation method, which
currently fails on most documents: Google redirects a script-blocked tab to a cookie-help page instead.

On any other web page it looks for what the page embeds and reads the file
itself rather than the viewer:

| Embed | Example | Read as |
|---|---|---|
| pdf.js viewer `viewer.html?file=…` | toanmath.com (WonderPlugin) | PDF |
| Office Online `view.officeapps.live.com/op/embed.aspx?src=…` | thuvienhoclieu.com | .docx |
| Google Docs viewer `docs.google.com/viewer?url=…` | many WordPress plugins | PDF |
| Google Drive `drive.google.com/file/d/…/preview` | Drive embeds | PDF or .docx |
| Embedded Google Doc / Sheet / Slides | `…/document/d/…/preview` | Docs / Sheets path; Slides as PDF |
| `<iframe>`/`<embed>`/`<object>` or an in-article link to a `.pdf`/`.docx` | — | PDF or .docx |

A page that embeds nothing gives its article text instead. A PDF opened
directly in a tab works too.

## Install

The extension loads in developer mode, not from the Chrome Web Store. Once per PC:

1. From [Releases](https://github.com/tranquanglam123/CopyDocsExtension/releases/latest), download `CopyDocExt.zip`.
2. Unzip it to a folder that stays, e.g. `Documents\CopyDocExt`.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick that folder.
4. In that folder, double-click `updater\install.bat`. If Windows says "Windows protected your PC", choose **More info → Run anyway**.
5. If the icon isn't visible, pin it from the puzzle-piece menu.

**Updates:** when a newer release is out, the icon shows **↑** and the popup an **Update** button. One click downloads it from GitHub, installs it over the folder and restarts the extension. `updater\uninstall.bat` removes the updater.

Windows only (Chrome and Edge). The updater refuses a git checkout — use `git pull` there.

**Publishing a release:** raise `version` in `manifest.json`, commit, push, then run `node tools/release/release.mjs` (needs `gh` signed in). It tags `v<version>` and uploads `CopyDocExt.zip`; installed copies see it within 12 hours.

## Use

1. Open a restricted Google Doc or Sheet, or a web page with embedded
   material, click the icon, then **Extract Content**. A file on another
   site makes Chrome ask once for access to that site.
2. Export the result:
   - **Copy** — formatted HTML to the clipboard, for Docs, Word, or any
     rich text editor.
   - **New Doc** — copies content, opens a blank Google Doc; press Ctrl+V.
   - **.docx** — a Word document with formatting and embedded pictures.
   - **.txt** — plain text.
   - **Original file** (web pages) — the embedded PDF/Word file itself,
     with equations and layout intact.

If the popup closes mid-extraction, click the icon again — the result is still there. The footer switches the interface between English and Vietnamese.

## Limits

Properties of the source document, not shortcuts in the extension:
- Equations and drawings are already rendered as pictures in Google's own
  HTML, so they arrive as images, not editable text or equations — and
  text drawn inside a picture cannot be recovered as selectable text.
- Only the first sheet of a spreadsheet is read.
- Google Slides is not supported — no reliable server-rendered path
  exists for it yet. Slides embedded in a web page are read through their
  PDF export.
- A PDF stores positioned text, not paragraphs or tables: tables come out
  as lines, and stacked maths (fractions) splits across lines. Scanned
  pages and pictures are kept as images.
- MathType equations in a .docx source become Word equations in the
  **.docx** download, editable without MathType. Copy and New Doc cannot
  carry equations (the clipboard holds HTML only), so there they are one
  line of text, e.g. `(x−1)/y`, `x²−2xy+y²`. An equation using a construct
  the converter does not know stays the original MathType object.
- Equations in a PDF are only positioned glyphs; no equation data survives
  the export to PDF, so they cannot come back as editable equations.
- Legacy Vietnamese fonts (VNI, TCVN3) read as garbled text; a warning
  says so.
- Old binary Office files (.doc, .ppt) and .pptx/.xlsx cannot be read
  yet — **Original file** still downloads them.

## Troubleshooting

| Problem | Cause |
|---|---|
| "Nothing to extract here" | The tab is a browser page or the Web Store, which extensions cannot read. |
| Embedded file could not be read | Access to its site was declined, or the owner disabled downloads. Try **Original file**. |
| Extraction fails after a long wait | Fetch failed and it fell back to tab navigation, which Google blocks on most documents. |
| .docx has no images | Pictures are written only when embedded: keep "Embed images" on. |
| Double-clicking an equation asks to convert it | That equation stayed a MathType object, and MathType is not installed. |

## Privacy

CopyDocExt sends nothing anywhere. It fetches from `docs.google.com`, and
from the site of a file a page embeds, using your own existing session, the
same access your browser already has. Other sites are only reachable after
you grant them in Chrome's prompt.
Parsing, formatting, and file generation all happen locally — no telemetry, no third-party server.

## Project structure

One folder per Chrome realm, plus two shared layers. Import rules: [AGENTS.md](AGENTS.md).

```
manifest.json
src/
  popup/       the popup page: view, controller, exports, docx
  background/  service worker; extract/ holds the four backends
  offscreen/   the parser: sandbox host, one pass per file, PDF/DOCX parsers
  content/     content script — readiness detection, and the web-page scan
  bridge/      the message contract, the facades, and all chrome.* calls
  lib/         pure logic — URL, embeds, PDF layout, MathType, CSV, zip, i18n
  vendor/      pdf.js, unmodified (Apache-2.0)
updater/       Windows helper that installs a GitHub release (native messaging)
tools/release/ publishes a release
```

## License

MIT — see [LICENSE](LICENSE).

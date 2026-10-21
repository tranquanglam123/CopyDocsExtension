# Parser harness

Runs the offscreen parsers and the .docx writer in a normal Chrome tab, and
checks their output, without loading the extension. Nothing here ships.

Fixtures are third-party learning material, so they stay out of the repo:
put them in a work folder (`WORK/fixtures/`), e.g. downloaded from

- PDF behind a pdf.js viewer: the `file=` URL in the iframe of
  `https://thcs.toanmath.com/2026/05/de-cuoi-ki-2-toan-8-nam-2025-2026-truong-thcs-le-thien-hai-phong.html`
- DOCX with 444 MathType equations, behind Office Online:
  `https://thuvienhoclieu.com/wp-content/uploads/2026/10/thuvienhoclieu.com-De-cuong-on-tap-giua-HK1-Toan-8-nam-26-27.docx`

## Serve

```
python -I tools/harness/serve.py <repo> <WORK> 18931
```

`/repo/*` is the repo, `/scratch/*` is WORK; a `PUT` to `/scratch/out/<name>`
writes `WORK/out/<name>`. Port 8765 is blocked on this machine; 18931 works.

## Pages

- `/repo/tools/harness/harness.html#file=/scratch/fixtures/x.pdf&type=pdf`
  — `parseFile()` and the rendered body HTML. `type=zip` for a .docx.
- `/repo/tools/harness/harness-docx.html?v=N#file=…&type=…&out=name.docx`
  — parse, JSON round trip (as storage does), `DocxGenerator`, PUT the
  .docx to `WORK/out/`. Change `?v=` after editing: the tab caches modules.

- `/repo/tools/harness/harness-pdf.html?v=N#file=/scratch/fixtures/x.pdf&from=7&to=8&png=1`
  — each PDF page beside the section `lib/pdf-layout.js` rebuilt from it,
  at the section's size and margins; PUTs the .docx (`out=`, default
  `pdf.docx`) and, with `png=1`, `WORK/out/pageN.png` of each pair. Read
  the PNGs: a screenshot of the long page times out. Equations show as
  their linear text, as in the popup.

All three disable `requestAnimationFrame`, as the hidden offscreen document does.
The Chrome automation tool refuses to return text that looks like a URL or
query string, so read results as numbers, or render them into the page and
take a screenshot.

## Checks

```
python -I tools/harness/check_docx.py WORK/out/pdf.docx
python -I tools/harness/validate_docx.py WORK/out/name.docx WORK/fixtures/source.docx
node tools/harness/mtef_dump.mjs <repo> <unzipped-docx>/word/embeddings WORK/out/eq.json
python -I tools/harness/mtef_check.py WORK/out/eq.json <unzipped-docx>/word
```

`check_docx.py` checks a generated file on its own: every part parses,
every relationship resolves, run, paragraph and cell properties come in
schema order, each table row spans its grid, and section properties sit
only in a paragraph or at the end of the body.
`validate_docx.py` checks the package (XML, relationships, content types)
and that kept OLE objects are byte-identical to the source. `mtef_check.py`
checks every converted equation's OMML parses and that its letters and
digits equal those MathType drew in the object's WMF preview.

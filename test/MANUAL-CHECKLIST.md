# Manual checklist — offscreen parser (P2)

Node has no CSS engine, so `node --test` can exercise the pure decision
logic (`lib/style-decision.js`, `lib/container-score.js`) but **cannot**
run a real cascade end-to-end. This checklist is the D2 regression test
(spec §11: *"feed a saved mobilebasic HTML fixture with class-based
font-weight:700 and assert `<b>` appears in bodyHtml"*) run against a real
Chrome DOM instead.

Fixture: `test/fixtures/mobilebasic-sample.html` — a `/mobilebasic`-shaped
page whose bold/italic/underline live in a `<style>` block as classes
(`.c1{font-weight:700}` etc.) on `<span>`s, exactly like real Google output,
plus Google-chrome noise (`#gb`, `.gb_xyz`, `.mobile-topbar`,
`.docs-butterbar`) and a `<script>` that must never run.

---

## Path A — parser only, no service-worker wiring required

This works today, independent of whatever the background-service-worker /
manifest wiring agent has landed, because it talks to `offscreen/parser.js`
directly instead of going through `chrome.offscreen.createDocument`.

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `CopyDocExt` project folder. Note the generated extension ID.
2. On the CopyDocExt card, click **Details** → turn on **Allow access to
   file URLs** (needed so the console can `fetch()` the local fixture file).
3. Open a new tab at:
   `chrome-extension://<EXTENSION_ID>/offscreen/parser.html`
4. Open DevTools (F12) on that tab → Console tab.
5. Run (adjust the file path to wherever you checked this repo out):

   ```js
   const html = await (await fetch(
     'file:///C:/PersonalProjects/CopyDocExt/test/fixtures/mobilebasic-sample.html'
   )).text();

   const response = await chrome.runtime.sendMessage({ type: 'parse', html, docType: 'docs' });
   console.log('ok:', response.ok);
   console.log('title:', response.data.title);
   console.log('charCount:', response.data.charCount);
   console.log('warnings:', response.data.meta.warnings);
   console.log(response.data.bodyHtml);
   ```

6. **Expected results** (this is the pass/fail bar):

   | Check | Expected |
   |---|---|
   | `response.ok` | `true` |
   | `response.data.title` | `"Quarterly Planning Notes"` — **not** `"SANDBOX ESCAPED"`. If it says SANDBOX ESCAPED, the fixture's `<script>` executed inside the iframe and the sandbox is broken (`allow-scripts` must NOT be on the iframe). |
   | `bodyHtml` contains `<b>bold text</b>` (or `<b>` wrapping equivalent text) | **This is the D2 fix.** Under the pre-fix `content-script.js` logic (`node.style` only), this is absent. |
   | `bodyHtml` contains `<i>italic text</i>` | present |
   | `bodyHtml` contains `<u>underlined text</u>` | present |
   | The "bold and italic at once" span | wrapped in at least `<b>` (priority order: bold beats italic — see `StyleDecision.styleToTag`) |
   | `bodyHtml` contains an `<h1>` and two `<h2>` | present, from the fixture's headings |
   | `bodyHtml` contains a `<ul>` with 3 `<li>` | present |
   | `bodyHtml` contains a `<table>` with a header row (`Quarter`/`Spend`) and two data rows | present |
   | `bodyHtml` does **not** contain `Sign out`, `gb_`, `mobile-topbar`, or `docs-butterbar` text | noise stripped |
   | `bodyHtml` does **not** contain any `class=` or `id=` attribute | stripped after style resolution |
   | `bodyHtml` does **not** contain `<script`, `onload=`, `onerror=`, or `javascript:` | sanitisation (`lib/html-sanitize.js`) |

7. Paste the returned `response.data.html` (the full wrapped document, not
   `bodyHtml`) into a scratch `.html` file and open it in a browser, or feed
   `response.data.bodyHtml` through `DocxGenerator.generate(bodyHtml, response.data.title)`
   (e.g. from the popup's console once wired) and open the resulting
   `.docx` in Word/LibreOffice — confirm bold/italic/underline actually
   render, closing the loop on acceptance criterion #2 in the spec
   ("Bold, italic, headings, lists and tables survive into the DOCX").

---

## Path B — full pipeline (wiring has landed)

`OffscreenManager` in `background/service-worker.js` now creates the offscreen
document and the `"offscreen"` permission is in `manifest.json`. The content
script sends `{ action:'contentReady', data:{ rawHtml, title, url, docType } }`
and the service worker routes `rawHtml` through the offscreen parser, falling
back to the in-page `DOMScanner` (via `{ action:'extract' }`) if that throws.

1. Reload the unpacked extension.
2. Open a real restricted Google Doc containing bold, italic, underlined
   text, a heading, a list, and a table.
3. Run the extension's extraction end-to-end (popup → Extract).
4. Inspect `chrome.storage.session.lastExtraction.bodyHtml` (or the popup's
   preview, once built) for the same `<b>`/`<i>`/`<u>` survival checks as
   Path A.
5. Download as `.docx` and open in Word/LibreOffice — same visual check as
   Path A step 7, but against a real document instead of the fixture.
6. Confirm `lastExtraction.meta.warnings` does **not** contain
   `"legacy_parser_fallback"`. If it does, the offscreen parse threw and the
   old in-page scanner produced the result — check the service worker console.

---

## Path C — P1 robustness (Chrome-only, none of it is unit-testable)

**C1 — watchdog restores a blocked tab (D3).** Start an extraction on a Doc,
then kill the service worker mid-flight (`chrome://serviceworker-internals`, or
the Stop button on `chrome://extensions`). Within ~60 s of the next wake, the
tab's scripts must be restored and `chrome://extensions` must show no orphaned
session rule. Verify with
`chrome.declarativeNetRequest.getSessionRules(console.log)` — nothing in the
9000-9999 band should survive.

**C2 — startup sweep.** Start an extraction, then restart Chrome while it is in
flight. After restart, the session-rule band must be empty and
`chrome.storage.session` must hold no `pipeline` or `ruleAlloc`.

**C3 — rule id allocation (D4).** Run extractions in two tabs whose ids differ
by exactly 1000 (open and close tabs until the ids line up). Both must succeed;
under the old `tabId % 1000` scheme they collided.

**C4 — Sheets via swFetch (D1).** Open a restricted Google Sheet and extract.
The user's tab must **not** navigate, and the result must carry
`meta.warnings: ['single_sheet_only']` shown as a yellow banner. Confirm the
data matches sheet `gid=0`.

**C5 — Sheets false-positive guard.** Extract a spreadsheet that legitimately
contains the words "Sign in" in a cell (an attendance/sign-in sheet). It must
extract normally — the access-wall regex only applies to non-CSV responses.

**C6 — Sheets access wall.** Extract a spreadsheet you do not have access to.
It must fail with a clear access/sign-in message, never with parsed garbage.

**C7 — Slides.** Open a Google Slides deck. The popup must say Slides is not
supported yet and must not start a pipeline.

---

## What is NOT covered by this checklist

- The structural container-detection **fallback** (`lib/container-score.js`
  scoring path) only activates when none of `OffscreenParser.CONTAINER_SELECTORS`
  match — the bundled fixture's `div.doc-content#contents` hits the fast
  path. To exercise the fallback manually, strip the fixture's
  `class="doc-content" id="contents"` attributes and re-run Path A; the
  parser should still find the content via scoring and
  `response.data.meta.warnings` should include `"container_fallback_used"`.
- Multi-tab Docs, multi-sheet Sheets, Slides, the quality gate, the ranker,
  and the transport tiers are **P3 scope** (`lib/strategy-registry.js`,
  `lib/quality-gate.js`, `lib/ranker.js`, `lib/transport.js` — not yet
  built) and are not exercised here.

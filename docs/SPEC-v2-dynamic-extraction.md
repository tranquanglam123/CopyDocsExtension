# CopyDocExt v2 — Dynamic Extraction Engine

**Status:** Draft, awaiting approval
**Date:** 2026-08-21
**Implementer:** Sonnet
**Baseline:** v1.1.0 (manifest says 1.0.0 — fix)

---

## 0. Problem

v1 hardcodes ONE extraction path: DNR-block JS → navigate the user's tab to
`/mobilebasic` → scrape DOM. Consequences:

- Sheets/Slides are broken today (`/mobilebasic` exists only for Docs).
- Formatting is mostly lost (see D2).
- A service-worker termination can leave a tab permanently script-blocked.
- The day Google changes `/mobilebasic`, the whole extension dies with no fallback.

v2 replaces the single path with a **ranked strategy registry + quality gate +
local self-ranking**, and removes tab hijacking from the primary path.

### 0.1 Non-goals

- No remote code execution (MV3 forbids it). Remote *config* only, opt-in, off by default.
- No Chrome Web Store submission in this version (unpacked install, per README).
- No OCR / screenshot fallback in v2 (tracked as future work).
- No change to `lib/mini-zip.js` or the DOCX/OOXML writer beyond its input contract.

---

## 1. Defects to fix (verify each with a test)

| ID | Location | Defect | Fix |
|----|----------|--------|-----|
| D1 | `lib/url-transformer.js:69-71` | Sheets/Slides mapped to `/mobilebasic`, which does not exist | Replaced by strategy registry (§3) |
| D2 | `content/content-script.js:113-137` | `removeAttribute('class')` runs before style resolution; mobilebasic puts bold/italic in a `<style>` block as classes, and only `node.style` (inline) is read → formatting lost | Resolve computed style in a real CSS cascade before stripping classes (§4.2) |
| D3 | `background/service-worker.js:96,308-311` | `_pendingExtraction` is in-memory; MV3 SW termination skips the `finally` that removes the JS-block rule → tab stays script-blocked until browser restart | Persisted state machine + `chrome.alarms` watchdog + startup sweep (§6) |
| D4 | `background/service-worker.js:31` | `BASE_RULE_ID + (tabId % 1000)` collides for tab ids 1000 apart | Rule-id allocation map in `storage.session` (§6.2) |
| D5 | `content/content-script.js:313-318` | Fixed `setTimeout(500)` before scan | Readiness detector (§4.4) — legacy path only |
| D6 | `content/content-script.js:36` | `.gb_` matches only the literal class `gb_`, not `gb_xyz` | `[class^="gb_"], [class*=" gb_"]` |
| D7 | `manifest.json:26-33` | Static ruleset `block_js` blocks **all** tabs if ever enabled | Delete the ruleset and `rules/` |
| D8 | `manifest.json:4` | Version 1.0.0 vs. release 1.1.0 | Set `2.0.0` |
| D9 | — | Multi-tab Docs (Google Docs Tabs, GA 2025) silently yield only the first tab | Tab enumeration (§3.4) |

---

## 2. Architecture

```
popup/  ──msg──►  background/service-worker.js  (orchestrator, state machine)
                        │
                        ├─► lib/strategy-registry.js   (data: what to try, in what order)
                        ├─► lib/transport.js           (how to fetch: 3 tiers, §3.2)
                        ├─► lib/quality-gate.js        (is this result good enough?)
                        ├─► lib/ranker.js              (local success stats, tier-bounded)
                        │
                        └─► offscreen/parser.html+js   (HTML → {title,text,bodyHtml}, §4)
```

The service worker never parses HTML (no DOM). All parsing happens in **one**
offscreen document.

---

## 3. Strategy registry

### 3.1 Schema (`lib/strategies.default.json`, data only — no code)

```jsonc
{
  "schemaVersion": 1,
  "strategies": [
    {
      "id": "docs-mobilebasic",
      "docType": "docs",              // docs | sheets | slides
      "url": "/document/d/{id}/mobilebasic{tabQuery}",
      "transport": "auto",            // auto | swFetch | csFetch | tabNav | tabRender
      "parser": "html",               // html | csv | text
      "fidelityTier": 1,              // 1 = best. NEVER learned/changed at runtime.
      "enabled": true
    }
  ]
}
```

`{id}` = doc id, `{tabQuery}` = `?tab=t.xxx` or `""`.

### 3.2 Transport tiers (tried in this order per strategy, first success wins)

| Tier | Mechanism | Why it exists |
|------|-----------|---------------|
| T1 `swFetch` | `fetch(url, {credentials:'include'})` from the service worker | Chrome treats extension→third-party as **same-site** when host permission is held, so even `SameSite=Strict` cookies are sent. No tab touched. |
| T2 `csFetch` | `chrome.scripting.executeScript` into the open docs.google.com tab, `fetch(path)` **same-origin**, return the HTML string | T1's same-site treatment **does not apply when third-party cookies are blocked** (Incognito, or user setting). T2 uses first-party cookies and is immune. Must stay same-origin: content-script fetches are subject to the page's CORS/CSP since Chrome 73; `connect-src 'self'` permits same-origin. |
| T3 `tabNav` | v1 behaviour: DNR block script → `tabs.update` → content script scrape → restore | Last resort only. Destroys the user's tab state. |
| T3b `tabRender` | Navigate + **JS enabled** + readiness detector + scrape | Slides only: `/preview` and `/embed` are JS-rendered, so blocking JS yields nothing. |

`transport: "auto"` = try T1, then T2. Never auto-escalates to T3/T3b; those are
explicit per-strategy.

Login-wall detection (`/ServiceLogin`, `accounts.google.com` redirect, `You need
access`) → treat as transport failure, move to the next tier.

### 3.3 Default chains

> **Measured 2026-08-22**, same-origin `fetch` from the document's own tab, on a
> genuinely restricted Doc:
>
> | Endpoint | Status | Length | Access wall |
> |----------|--------|--------|-------------|
> | `/mobilebasic` | 200 | 784 354 | no |
> | `/export?format=html` | 403 | — | — |
> | `/preview` | 200 | 1 040 567 | no (JS shell) |
> | `/pub?embedded=true` | 403 | — | — |
>
> `/mobilebasic` is alive and fetchable. What is broken is the **`tabNav`
> mechanism**, not the endpoint: blocking scripts and then navigating the tab
> makes Google redirect to `support.google.com/accounts/answer/32050` ("clear
> cache and cookies") because its cookie/consent bootstrap cannot run. This is
> why T1/T2 were pulled forward from P3 into the shipped Docs path, and why
> `tabNav` is now a last-resort fallback rather than the primary route.

**docs** (tier 1 → 3)

1. `docs-mobilebasic` — `/document/d/{id}/mobilebasic{tabQuery}` · html · tier 1 · auto
2. `docs-export-html` — `/document/d/{id}/export?format=html{&tab}` · html · tier 1 · auto
   *(403 when download is restricted — cheap to try, high value when it works)*
3. `docs-pub` — `/document/d/{id}/pub?embedded=true` · html · tier 2 · auto
   *(only for docs explicitly Published to web)*
4. `docs-tabnav` — `/document/d/{id}/mobilebasic{tabQuery}` · html · tier 3 · tabNav

**sheets** (mobilebasic does NOT exist for sheets — confirmed)

1. `sheets-gviz-csv` — `/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&gid={gid}` · csv · tier 1 · auto
2. `sheets-htmlview` — `/spreadsheets/d/{id}/htmlview` · html · tier 2 · auto
3. `sheets-export-csv` — `/spreadsheets/d/{id}/export?format=csv&gid={gid}` · csv · tier 2 · auto

Sheet `gid` enumeration: parse `htmlview` or the gviz error payload for the sheet
list; fall back to `gid=0` only, and **warn the user** that only one sheet was read.

**slides** (experimental — no reliable server-rendered path exists)

1. `slides-export-txt` — `/presentation/d/{id}/export/txt` · text · tier 2 · auto
2. `slides-export-html` — `/presentation/d/{id}/export?format=html` · html · tier 2 · auto
3. `slides-htmlpresent` — `/presentation/d/{id}/htmlpresent` · html · tier 3 · auto
4. `slides-render` — `/presentation/d/{id}/preview` · html · tier 3 · **tabRender**

The popup must label Slides results as `experimental` until the health check
(§7) proves a path.

### 3.4 Docs Tabs (D9)

Before running the docs chain:

1. Fetch `/document/d/{id}/mobilebasic` once.
2. Extract tab ids by matching `?tab=t.[a-z0-9]+` in the returned HTML, dedup, preserve order.
3. If ≥2 tabs found, run the winning strategy once per tab and concatenate,
   each section prefixed by an `<h1>` with the tab title when discoverable.
4. If 0 or 1 found, single-pass as today.
5. The popup shows `n tabs extracted`.

`?tab=` is undocumented — if enumeration finds tabs but per-tab fetches all fail,
fall back to single-pass and surface the warning `Multi-tab doc: only first tab
extracted`. **Never silently drop tabs.**

---

## 4. Parsing (offscreen document)

### 4.1 Why offscreen

The service worker has no `DOMParser`/`getComputedStyle`. Use
`chrome.offscreen.createDocument({reasons:['DOM_PARSER']})`, one at a time,
closed after each extraction (or after 30 s idle).

### 4.2 Format fidelity (fixes D2)

Inside the offscreen document:

1. Create `<iframe sandbox="allow-same-origin">` (no `allow-scripts` → page scripts
   never execute; `allow-same-origin` → we can read its DOM).
2. Write the fetched HTML into it via `srcdoc`. The document's own `<style>` block
   now participates in a real CSS cascade.
3. Run the extraction against the iframe document, using **`getComputedStyle(node)`**
   (not `node.style`) to decide bold / italic / underline / alignment / indent.
4. Only then strip `class` / `id` and emit clean HTML.

Sanitisation before anything is read: remove `<script>`, `<iframe>`, `<object>`,
every `on*` attribute, and any `href`/`src` starting with `javascript:`.

### 4.3 Container detection (replaces the hardcoded selector list)

1. **Fast path** — try the known selectors (`div.doc-content`, `#contents`, `[role="main"]`, …).
2. **Structural fallback** (used when the fast path yields a container failing the
   gate): score every block element as
   `score = textLength * (1 - linkDensity) * (1 + 0.1 * paragraphCount)`,
   excluding nav/header/footer/aside; pick the highest-scoring subtree.
   Class names are never required — this is what survives Google renaming things.

### 4.4 Readiness detector (fixes D5, legacy `tabNav`/`tabRender` only)

`MutationObserver` on `document.body` + poll `document.body.textContent.length`
every 250 ms. Ready when the length is unchanged across 2 consecutive polls,
minimum wait 300 ms, hard cap 10 s. For `tabRender` (Slides) additionally scroll
to the bottom once and re-wait, to force lazy slides to render.

### 4.5 Parser output

Same contract as v1 so `lib/docx-generator.js` is untouched:

```js
{ title, text, html, bodyHtml, charCount,
  meta: { strategyId, transport, tabsFound, tabsExtracted, sheetsFound,
          sheetsExtracted, score, warnings: string[] } }
```

CSV parser: RFC-4180 (quoted fields, embedded newlines/commas) → `<table>`;
first row becomes `<th>` only if every cell is non-numeric.

---

## 5. Quality gate + ranking

### 5.1 Gate (`lib/quality-gate.js`)

```
score = 0
score += min(textLength / 500, 40)          // volume, capped
score += min(blockCount * 2, 20)            // paragraphs/rows/headings
score += hasTitle ? 10 : 0
score += hasStructure(table|list|heading) ? 10 : 0
score -= linkDensity > 0.5 ? 20 : 0
score -= /Sign in|You need access|Request access|Page not found/i ? 60 : 0
score -= textLength < 40 ? 40 : 0
PASS if score >= 35
```

Thresholds live in the config file, not in code.

**Never hard-fail:** if every strategy fails the gate, return the
highest-scoring result with `warnings: ['low_confidence']` and let the popup
show a yellow banner. A genuinely short document must still be extractable.

### 5.2 Ranker (`lib/ranker.js`)

`chrome.storage.local.strategyStats = { [id]: { ok, fail, lastOkAt } }`

Ordering, per doc type:

```
sort by (fidelityTier ASC, successRate DESC, lastOkAt DESC)
successRate = (ok + 1) / (ok + fail + 2)         // Laplace smoothing
decay: halve ok and fail whenever ok + fail > 40 // recency
```

**Hard rule:** learning reorders only *within* a `fidelityTier`. A tier-3
strategy can never be tried before a tier-1 strategy that is still passing —
otherwise the extension teaches itself to prefer a cheap path that returns
truncated content. A tier is skipped only after every strategy in it has failed
3 consecutive times, and it is retried once every 7 days regardless.

---

## 6. Robustness

### 6.1 Persisted state machine (fixes D3)

`chrome.storage.session.pipeline = { phase, tabId, ruleId, startedAt, docId, strategyIdx }`

- Written before every side effect, cleared on completion.
- `chrome.alarms` watchdog every 60 s: any pipeline with
  `now - startedAt > 60_000` → remove its DNR rule, mark `extractionStatus:'error'`, clear.
- `chrome.runtime.onStartup` + `onInstalled`: enumerate all session rules in the
  `9000-9999` band and remove them.
- The `finally` in `runPipeline` stays, but is no longer the only guarantee.

### 6.2 Rule id allocation (fixes D4)

`storage.session.ruleAlloc = { [ruleId]: tabId }`; allocate the lowest free id in
`9000..9999`; release on completion, tab close, and watchdog timeout. Throw a
clear error if the band is exhausted.

### 6.3 Concurrency

One extraction at a time, keyed by tabId. A second `startExtraction` while one is
running returns `{success:false, error:'extraction_in_progress'}` instead of
corrupting the pending-extraction slot.

---

## 7. Health check + diagnostics

New popup section, collapsed by default:

- **`Run health check`** — runs every strategy against the currently open document
  (not a hardcoded third-party doc), reports a table: strategy · transport ·
  HTTP status · score · pass/fail · ms. Read-only, changes no stats.
- **Last result** — shows `meta.strategyId`, `transport`, tabs/sheets counts, warnings.

This is what makes the extension debuggable in two years without reading code.

---

## 8. Config: local first, remote opt-in

- `lib/strategies.default.json` is bundled and is always the seed.
- `chrome.storage.local.strategiesOverride` may hold a newer config, applied only
  when `schemaVersion` matches and validation passes.
- Two ways to set it:
  1. **Import/paste JSON** in the popup (offline, no new permissions) — default path.
  2. **Remote refresh**, default **OFF**. Behind an explicit toggle that requests
     `optional_host_permissions: ["https://raw.githubusercontent.com/*"]` at the
     moment the user enables it, so the install-time permission warning does not grow.
     24 h interval, validate schema, reject unknown fields, never accept anything
     that is not a URL template / selector / number / boolean.
- README's privacy section must be updated to state exactly this (download-only,
  opt-in, nothing is ever uploaded).

---

## 9. Manifest changes

```jsonc
{
  "version": "2.0.0",
  "permissions": ["activeTab","scripting","clipboardWrite","downloads",
                  "declarativeNetRequest","notifications","storage",
                  "offscreen","alarms"],
  "optional_host_permissions": ["https://raw.githubusercontent.com/*"],
  // delete declarative_net_request.rule_resources (D7) and the rules/ directory
}
```

`content_scripts` static registration stays for the legacy `tabNav` path;
`csFetch` and `tabRender` inject via `chrome.scripting.executeScript`.

---

## 10. File plan

| File | Action |
|------|--------|
| `lib/strategies.default.json` | NEW — registry data |
| `lib/strategy-registry.js` | NEW — load/validate/merge config, resolve URL templates, order via ranker |
| `lib/transport.js` | NEW — T1/T2/T3 fetch tiers, login-wall detection |
| `lib/quality-gate.js` | NEW — scoring |
| `lib/ranker.js` | NEW — stats, tier-bounded ordering |
| `lib/csv-to-html.js` | NEW — RFC-4180 → table |
| `offscreen/parser.html` | NEW |
| `offscreen/parser.js` | NEW — sandboxed-iframe parse, computed-style resolution, structural container detection |
| `background/service-worker.js` | REWRITE — orchestrator, persisted state machine, watchdog, rule allocator |
| `content/content-script.js` | REWRITE — thin: `csFetch` helper, readiness detector, legacy scrape delegating to the same parse core |
| `lib/url-transformer.js` | TRIM — identify/getDocId/getTypeLabel only; drop `toMobileBasic` |
| `popup/popup.js`, `.html`, `.css` | EXTEND — warnings banner, diagnostics panel, config import |
| `lib/docx-generator.js`, `lib/mini-zip.js` | UNCHANGED |
| `lib/export-service.js` | KEEP — add `text/html` clipboard item |
| `manifest.json` | UPDATE (§9) |
| `rules/`, `_metadata/` | DELETE |
| `test/` | NEW (§11) |

---

## 11. Tests

No framework is currently present. Add plain-Node unit tests (`node --test`,
zero deps) for the pure modules — these must not require Chrome:

- `quality-gate`: login-wall HTML scores < 35; a 3-paragraph doc scores ≥ 35; a
  40-char doc is low-confidence but still returned.
- `ranker`: tier-1 failing 2× still outranks tier-3; after 3 consecutive tier-1
  failures tier-2 is tried; decay halves counts past 40; 7-day retry fires.
- `csv-to-html`: quoted commas, embedded newlines, escaped quotes, numeric header row.
- `strategy-registry`: template resolution, schema rejection of an unknown field,
  rejection of a `schemaVersion` mismatch.
- `parser`: feed a saved mobilebasic HTML fixture with class-based
  `font-weight:700` and assert `<b>` appears in `bodyHtml` — **this is the D2
  regression test**. If a real cascade cannot run under `node --test`, this one
  test moves to a manual checklist item with a saved fixture in `test/fixtures/`.

Manual checklist (must be run against real documents before release):
a restricted Doc, a multi-tab Doc, a multi-sheet restricted Sheet, a restricted
Slides deck, an unrestricted Doc, Incognito with 3P cookies blocked (proves T2),
and a mid-extraction service-worker kill (proves the watchdog restores JS).

---

## 12. Acceptance criteria

1. A restricted Google **Doc** extracts without navigating the user's tab, and
   `meta.transport` reports `swFetch` or `csFetch`.
2. Bold, italic, headings, lists and tables survive into the DOCX — verified
   against a fixture with class-based styling (D2).
3. A restricted **Sheet** extracts all sheets, or extracts sheet 0 and warns.
4. A multi-tab **Doc** extracts every tab, or extracts tab 1 and warns. Never silent.
5. **Slides** either extracts or reports `experimental — no working path`, and
   never leaves the tab in a broken state.
6. Killing the service worker mid-extraction leaves **no** tab with scripts blocked
   after the watchdog interval.
7. Disabling `docs-mobilebasic` in config makes the extension fall through to the
   next tier and still extract — proving the chain is real, not decorative.
8. Health check renders a per-strategy result table.
9. All §11 unit tests pass.
10. README updated: new architecture, Slides caveat, privacy wording for remote config.

---

## 13. Phasing (each phase is independently shippable)

- **P1 — stop the bleeding.** D3, D4, D7, D8 + Sheets `gviz` in place of the
  non-existent mobilebasic mapping (D1). No architecture change.
- **P2 — parsing core.** Offscreen + sandboxed iframe + computed style (D2),
  structural container detection, CSV parser, unit tests.
- **P3 — strategy engine.** Registry, quality gate, ranker, Docs Tabs (D9).
  *(Transports T1/T2 were pulled forward out of this phase — see the measurement
  note in §3.3. `tabNav` is already demoted to a last-resort fallback.)*
- **P4 — operability.** Health check, diagnostics, config import, opt-in remote
  refresh, README.

---

## 14. Known risks (accepted)

- `?tab=` and `gviz` are undocumented endpoints; they can vanish. Mitigation is
  the chain itself plus the health check, not a guarantee.
- Slides has no known reliable path; v2 ships it as experimental on purpose.
- If Google converts `/mobilebasic` to a JS-rendered view, T1/T2 stop working for
  it; the chain falls to `tabRender`, which is slower and hijacks the tab. This is
  the designed failure mode, not an outage.
- The `tabNav` fallback is **known to fail on Docs as of 2026-08-22** — it trips
  the `answer/32050` cookie redirect described in §3.3. It is kept only because a
  future Google change could make it viable again; it must not be counted on. If
  T1 and T2 both fail, treat that as a genuine outage and reach for the health
  check, not for `tabNav`.
- The extension defeats a document owner's copy/download restriction. It stays a
  personal/educational, unpacked-install tool; the README disclaimer stands and
  Chrome Web Store submission is out of scope.

---

## 15. Sources consulted

- Chrome for Developers — *Storage and cookies*: extension→third-party requests are
  same-site with host permissions; not when third-party cookies are blocked.
- Chromium — *Changes to Cross-Origin Requests in Chrome Extension Content Scripts*:
  content-script fetches follow the page's CORS/CSP since Chrome 73.
- Google Workspace developer docs + community threads — Docs Tabs, `?tab=` export
  parameter is undocumented; native export covers only the first tab.
- Community/prior-art reports (2025–2026) — `/mobilebasic` still the primary Docs
  path and does not work for Sheets; `gviz/tq?tqx=out:csv` reads view-only sheets.

/**
 * Every value more than one layer has to agree on. A typo in a duplicated
 * literal fails silently: the toggle stops persisting, or a warning renders
 * as its raw code. Nothing here may import anything.
 */

// ─── Storage keys ───────────────────────────────────────────────────────────

/** `chrome.storage.session` — cleared when the browser closes. */
export const SESSION_KEYS = Object.freeze({
    /** In-flight pipeline breadcrumb the watchdog reads to recover a killed SW. */
    PIPELINE: 'pipeline',
    /** Map of allocated DNR rule id → tab id. */
    RULE_ALLOC: 'ruleAlloc',
    /** 'idle' | 'running' | 'complete' | 'error'. */
    EXTRACTION_STATUS: 'extractionStatus',
    /** Human-readable message for the last failure. */
    LAST_EXTRACTION_ERROR: 'lastExtractionError',
});

/** `chrome.storage.local` — survives browser restarts. */
export const LOCAL_KEYS = Object.freeze({
    /** Popup toggle: inline images as data: URIs. */
    EMBED_IMAGES: 'embedImagesEnabled',
    /** Selected UI language ('en' | 'vi'), set from the popup. */
    LANGUAGE: 'uiLanguage',
    /**
     * Last completed extraction result, so a reopened popup can recover it.
     * Embedded images can run tens of MB — storage.session's ~10MB quota
     * cannot be lifted, storage.local's can (unlimitedStorage), so this one
     * key lives in local despite the rest of the extraction state being
     * session-scoped.
     */
    LAST_EXTRACTION: 'lastExtraction',
});

// ─── Extraction status values ───────────────────────────────────────────────

export const EXTRACTION_STATUS = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    COMPLETE: 'complete',
    ERROR: 'error',
});

// ─── Popup views ────────────────────────────────────────────────────────────
// One name per thing the popup can be showing. lib/resume.js picks the one to
// open with; the controller re-renders whichever is current on a language switch.

export const VIEWS = Object.freeze({
    IDLE: 'idle',
    DOC_DETECTED: 'docDetected',
    NOT_A_DOC: 'notADoc',
    SLIDES_UNSUPPORTED: 'slidesUnsupported',
    RECOVERY_RUNNING: 'recoveryRunning',
    EXTRACTING: 'extracting',
    RESULT: 'result',
    FAILED: 'failed',
    INIT_ERROR: 'initError',
});

// ─── Warning codes ──────────────────────────────────────────────────────────
// Codes, never English sentences, so the popup can translate them.
// `image_embed_failed` and `image_not_bitmap` carry a `:<count>` suffix.

export const WARNINGS = Object.freeze({
    /** Only sheet gid=0 was read from a multi-sheet spreadsheet. */
    SINGLE_SHEET_ONLY: 'single_sheet_only',
    /** Fetch transports failed; the legacy tab-navigation path produced this. */
    TABNAV_FALLBACK: 'tabnav_fallback',
    /** Offscreen parse failed; the in-page scanner produced this. */
    LEGACY_PARSER_FALLBACK: 'legacy_parser_fallback',
    /** Output exceeded the size budget, so computed-style fill was skipped. */
    STYLE_FILL_SKIPPED_SIZE: 'style_fill_skipped_size',
    /** Structural scoring, not a known selector, located the content. */
    CONTAINER_FALLBACK_USED: 'container_fallback_used',
    /** No content container could be identified at all. */
    CONTAINER_NOT_FOUND: 'container_not_found',
    /** A container was found but held no text. */
    EMPTY_CONTENT: 'empty_content',
    /** Image embedding stopped because the byte budget was exhausted. */
    IMAGE_BUDGET_EXCEEDED: 'image_budget_exceeded',
});

/** Warning codes that carry a `:<count>` suffix. */
export const WARNING_PREFIXES = Object.freeze({
    /** One or more images could not be fetched; originals kept. */
    IMAGE_EMBED_FAILED: 'image_embed_failed',
    /** A source did not return `image/*`; the original URL was kept. */
    IMAGE_NOT_BITMAP: 'image_not_bitmap',
});

// ─── Alarms ─────────────────────────────────────────────────────────────────

export const ALARMS = Object.freeze({
    /** Reaps pipelines abandoned by a terminated service worker. */
    PIPELINE_WATCHDOG: 'pipelineWatchdog',
});

// ─── Timing and limits ──────────────────────────────────────────────────────

export const TIMING = Object.freeze({
    /** A pipeline older than this is abandoned and force-recovered. */
    PIPELINE_TIMEOUT_MS: 60_000,
    /** Close the offscreen document after this much idle time. */
    OFFSCREEN_IDLE_CLOSE_MS: 30_000,
    /** Give up waiting for the sandboxed iframe to load. */
    SANDBOX_LOAD_TIMEOUT_MS: 10_000,
    /** Give up waiting for a navigated tab to finish loading. */
    TAB_LOAD_TIMEOUT_MS: 15_000,
});

/** Session DNR rule id band reserved for this extension. */
export const RULE_ID_BAND = Object.freeze({
    MIN: 9000,
    MAX: 9999,
});

export const IMAGE_LIMITS = Object.freeze({
    PER_IMAGE_MAX_BYTES: 4 * 1024 * 1024,
    TOTAL_BUDGET_BYTES: 12 * 1024 * 1024,
    MAX_CONCURRENT: 4,
    TIMEOUT_MS: 8_000,
});

/** Above this, the computed-style fill is skipped. */
export const STYLE_FILL_MAX_BYTES = 4 * 1024 * 1024;

// ─── Document types ─────────────────────────────────────────────────────────

export const DOC_TYPES = Object.freeze({
    DOCS: 'docs',
    SHEETS: 'sheets',
    SLIDES: 'slides',
});

// ─── Transport tiers ────────────────────────────────────────────────────────

export const TRANSPORTS = Object.freeze({
    SW_FETCH: 'swFetch',
    CS_FETCH: 'csFetch',
    TAB_NAV: 'tabNav',
});

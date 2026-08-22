import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideInitialView } from '../src/lib/resume.js';
import { EXTRACTION_STATUS, DOC_TYPES, VIEWS } from '../src/lib/const.js';

// What the popup shows when it opens. Pure, so the one case that broke the
// extension — a finished result outliving the tab it came from — is testable
// without a DOM.

const docTab = (docId, type = DOC_TYPES.DOCS) => ({
    isValid: true, type, docId, url: `https://docs.google.com/document/d/${docId}/edit`, title: 'Doc',
});

const resultFor = (docId) => ({ title: 'Doc', charCount: 10, meta: { docId } });

describe('decideInitialView', () => {

    test('a finished result shows only on the document it came from', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: resultFor('AAA'),
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.RESULT);
        assert.equal(decision.result.meta.docId, 'AAA');
    });

    test('a finished result never blocks a different document', () => {
        // The bug: the popup showed doc 1's result on every tab for the rest
        // of the browser session, with the extract button disabled.
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: resultFor('AAA'),
            tab: docTab('BBB'),
        });
        assert.equal(decision.view, VIEWS.DOC_DETECTED);
        assert.equal(decision.tab.docId, 'BBB');
    });

    test('a result stored before docIds were stamped is not trusted', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: { title: 'Doc', charCount: 10, meta: {} },
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.DOC_DETECTED);
    });

    test('a finished result on a non-document tab does not show', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: resultFor('AAA'),
            tab: { isValid: false },
        });
        assert.equal(decision.view, VIEWS.NOT_A_DOC);
    });

    test('a running extraction wins over everything — it is still in flight', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.RUNNING,
            storedResult: null,
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.RECOVERY_RUNNING);
    });

    test('a running extraction shows recovery even on an unrelated tab', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.RUNNING,
            storedResult: null,
            tab: { isValid: false },
        });
        assert.equal(decision.view, VIEWS.RECOVERY_RUNNING);
    });

    test('COMPLETE with no stored result falls through to the tab', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: null,
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.DOC_DETECTED);
    });

    test('a failed extraction leaves the current document extractable', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.ERROR,
            storedResult: null,
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.DOC_DETECTED);
    });

    test('idle on a document offers extraction', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.IDLE,
            storedResult: null,
            tab: docTab('AAA'),
        });
        assert.equal(decision.view, VIEWS.DOC_DETECTED);
        assert.equal(decision.tab.type, DOC_TYPES.DOCS);
    });

    test('idle on a non-document tab', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.IDLE,
            storedResult: null,
            tab: { isValid: false },
        });
        assert.equal(decision.view, VIEWS.NOT_A_DOC);
    });

    test('a missing tab is treated as no document', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.IDLE,
            storedResult: null,
            tab: null,
        });
        assert.equal(decision.view, VIEWS.NOT_A_DOC);
    });

    test('Slides is reported unsupported rather than offered', () => {
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.IDLE,
            storedResult: null,
            tab: docTab('AAA', DOC_TYPES.SLIDES),
        });
        assert.equal(decision.view, VIEWS.SLIDES_UNSUPPORTED);
    });

    test('a Slides tab still shows a result that belongs to it', () => {
        // Slides cannot be extracted today, but if one ever completed, the
        // result belongs to that tab and must not be hidden.
        const decision = decideInitialView({
            status: EXTRACTION_STATUS.COMPLETE,
            storedResult: resultFor('AAA'),
            tab: docTab('AAA', DOC_TYPES.SLIDES),
        });
        assert.equal(decision.view, VIEWS.RESULT);
    });
});

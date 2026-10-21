import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewer, readRelease, needsCheck } from '../src/lib/update.js';

const ASSET = 'CopyDocExt.zip';
const release = (over = {}) => ({
    tag_name: 'v2.2.0',
    draft: false,
    prerelease: false,
    assets: [{ name: ASSET, browser_download_url: 'https://github.com/x/y/releases/download/v2.2.0/CopyDocExt.zip' }],
    ...over,
});

describe('parseVersion', () => {
    test('reads a manifest version and a v-prefixed tag alike', () => {
        assert.deepEqual(parseVersion('2.1.0'), [2, 1, 0]);
        assert.deepEqual(parseVersion('v2.10'), [2, 10]);
    });

    test('anything but dotted numbers is not a version', () => {
        for (const bad of ['', null, undefined, 'v2.1.0-beta', 'latest', '2..1', '1.2.3.4.5']) {
            assert.equal(parseVersion(bad), null, String(bad));
        }
    });
});

describe('isNewer', () => {
    test('compares numerically, not as text', () => {
        assert.equal(isNewer('2.10.0', '2.9.0'), true);
        assert.equal(isNewer('v2.1.1', '2.1.0'), true);
        assert.equal(isNewer('3', '2.9.9'), true);
    });

    test('equal or older is not an update, and missing parts count as zero', () => {
        assert.equal(isNewer('2.1.0', '2.1.0'), false);
        assert.equal(isNewer('2.1', '2.1.0'), false);
        assert.equal(isNewer('2.0.9', '2.1.0'), false);
    });

    test('an unreadable version never offers an update', () => {
        assert.equal(isNewer('nightly', '2.1.0'), false);
        assert.equal(isNewer('2.2.0', ''), false);
    });
});

describe('readRelease', () => {
    test('a published release with the asset gives its version', () => {
        assert.deepEqual(readRelease(release(), ASSET), { version: '2.2.0' });
    });

    test('no asset, a draft, a prerelease or an odd tag is not installable', () => {
        assert.equal(readRelease(release({ assets: [{ name: 'other.zip' }] }), ASSET), null);
        assert.equal(readRelease(release({ assets: undefined }), ASSET), null);
        assert.equal(readRelease(release({ draft: true }), ASSET), null);
        assert.equal(readRelease(release({ prerelease: true }), ASSET), null);
        assert.equal(readRelease(release({ tag_name: 'release-2' }), ASSET), null);
        assert.equal(readRelease(null, ASSET), null);
    });
});

describe('needsCheck', () => {
    const HOUR = 3_600_000;

    test('a fresh check by this version is kept', () => {
        assert.equal(needsCheck({ current: '2.1.0', checkedAt: 1000 }, '2.1.0', 1000 + HOUR, 6 * HOUR), false);
    });

    test('a missing, stale or other-version check is redone', () => {
        assert.equal(needsCheck(null, '2.1.0', 0, 6 * HOUR), true);
        assert.equal(needsCheck({ current: '2.1.0', checkedAt: 0 }, '2.1.0', 7 * HOUR, 6 * HOUR), true);
        assert.equal(needsCheck({ current: '2.0.0', checkedAt: 0 }, '2.1.0', 1, 6 * HOUR), true);
        assert.equal(needsCheck({ current: '2.1.0' }, '2.1.0', 1, 6 * HOUR), true);
    });
});

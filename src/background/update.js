/**
 * Self-update for copies loaded unpacked. GitHub's latest release says what
 * is newest; the native helper registered by updater/install.bat downloads
 * it over the extension folder, and a reload starts the new files.
 */
import { UPDATE } from '../lib/const.js';
import { readRelease, isNewer, needsCheck } from '../lib/update.js';
import { callNativeHost } from '../bridge/chrome/native.js';
import { setBadge } from '../bridge/chrome/action.js';
import { getExtensionVersion, reloadExtension } from '../bridge/chrome/runtime.js';
import { getUpdateInfo, setUpdateInfo } from '../bridge/chrome/storage.js';

/**
 * Asks GitHub, stores the answer and sets the badge.
 * @returns {Promise<{current: string, latest: string|null, available: boolean, helper: boolean, checkedAt: number}>}
 */
export async function checkForUpdate() {
    const current = getExtensionVersion();
    const resp = await fetch(`https://api.github.com/repos/${UPDATE.REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
    });
    // 404: the repository has no release yet.
    if (!resp.ok && resp.status !== 404) throw new Error(`GitHub answered ${resp.status}`);
    const release = resp.ok ? readRelease(await resp.json(), UPDATE.ASSET) : null;
    const available = !!release && isNewer(release.version, current);
    // Probed only when there is something to install: each call starts a process.
    const helper = available ? await pingHelper() : false;

    const info = { current, latest: release?.version || null, available, helper, checkedAt: Date.now() };
    await setUpdateInfo(info);
    await setBadge(available ? UPDATE.BADGE : '');
    return info;
}

/**
 * The stored check, redone first when stale. Offline, the stored one stands.
 */
export async function getUpdateStatus() {
    const stored = await getUpdateInfo();
    const maxAge = stored?.available ? UPDATE.CHECK_MAX_AGE_MS : UPDATE.CHECK_IDLE_MAX_AGE_MS;
    if (!needsCheck(stored, getExtensionVersion(), Date.now(), maxAge)) {
        // install.bat may have run since; it needs no reload to take effect.
        if (stored.available && !stored.helper && await pingHelper()) {
            stored.helper = true;
            await setUpdateInfo(stored);
        }
        return stored;
    }
    try {
        return await checkForUpdate();
    } catch (err) {
        console.warn('[update] check failed:', err.message);
        return stored?.current === getExtensionVersion() ? stored : null;
    }
}

/**
 * Has the helper install the latest release, then reloads. The helper
 * re-reads the release itself, so nothing here can point it elsewhere.
 * @returns {Promise<{version: string}>}
 */
export async function applyUpdate() {
    const reply = await callNativeHost(UPDATE.HOST, { cmd: 'update' }, UPDATE.INSTALL_TIMEOUT_MS);
    if (!reply?.ok) throw new Error(reply?.error || 'The updater gave no answer');
    await setBadge('');
    setTimeout(reloadExtension, UPDATE.RELOAD_DELAY_MS);
    return { version: reply.version };
}

async function pingHelper() {
    try {
        const reply = await callNativeHost(UPDATE.HOST, { cmd: 'ping' }, UPDATE.PING_TIMEOUT_MS);
        return !!reply?.ok;
    } catch {
        return false;
    }
}

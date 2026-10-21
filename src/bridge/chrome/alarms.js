/**
 * chrome.alarms wiring for the watchdog and the update check. The work itself
 * is run.js's `runWatchdog` and update.js's `checkForUpdate`; this file only
 * registers the alarms.
 */
import { ALARMS, UPDATE } from '../../lib/const.js';

/**
 * Idempotent: re-creating an alarm with the same name resets it. Fires every
 * minute.
 */
export function createWatchdogAlarm() {
    chrome.alarms.create(ALARMS.PIPELINE_WATCHDOG, { periodInMinutes: 1 });
}

/**
 * @param {() => void} handler  Called with no arguments when the watchdog
 *   alarm fires; any other alarm is ignored.
 */
export function onWatchdogAlarm(handler) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARMS.PIPELINE_WATCHDOG) {
            handler();
        }
    });
}

/**
 * Created only when missing: the worker starts many times a day, and
 * re-creating the alarm each time would keep pushing the check back.
 */
export async function ensureUpdateAlarm() {
    if (await chrome.alarms.get(ALARMS.UPDATE_CHECK)) return;
    await chrome.alarms.create(ALARMS.UPDATE_CHECK, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE.CHECK_PERIOD_MINUTES,
    });
}

/** @param {() => void} handler  Called when the update-check alarm fires. */
export function onUpdateAlarm(handler) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARMS.UPDATE_CHECK) {
            handler();
        }
    });
}

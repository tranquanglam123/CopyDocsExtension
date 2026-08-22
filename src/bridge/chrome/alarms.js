/**
 * chrome.alarms wiring for the watchdog. The recovery itself is run.js's
 * `runWatchdog`; this file only registers the alarm.
 */
import { ALARMS } from '../../lib/const.js';

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

/**
 * alarms.js — chrome.alarms wiring for the pipeline watchdog (spec v3
 * §2/§4 P2). Moved from background/service-worker.js's
 * `ExtensionController.init`. The watchdog's own recovery logic lives in
 * extraction/pipeline-runner.js's `runWatchdog` — this file only owns the
 * alarm registration/creation.
 */
import { ALARMS } from '../../lib/const.js';

/**
 * Idempotent — re-creating an alarm with the same name just resets it.
 * Fires every minute; any pipeline older than the watchdog timeout is
 * treated as abandoned (see extraction/pipeline-runner.js `runWatchdog`).
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

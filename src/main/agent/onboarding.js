// Nova — agent/onboarding.js
//
// First-run permission onboarding (Stage 5 req 5):
//   - Explains WHY each OS permission is needed BEFORE the OS prompt appears.
//   - Detects current permission state per OS and stores per-permission
//     acknowledgement, so the onboarding screens show once until acknowledged.
//
// Permissions Nova may request:
//   macOS Screen Recording  → vision ("what's on my screen")
//   macOS Accessibility     → control (mouse/keyboard simulation)
//   Windows: neither is needed (screen capture and input simulation work
//     without extra OS permissions).
//
// The renderer shows one screen per pending permission (why needed, what the
// OS prompt will ask, an "Allow" button that triggers the real OS prompt by
// attempting the operation that forces the OS dialog).

const { execSync } = require("child_process");
const log = require("electron-log");
const settings = require("../settings");

/** Acknowledged-onboarding flags are stored in settings.json. */
const ACK_KEYS = {
  screenRecording: "onboardingAckScreenRecording",
  accessibility: "onboardingAckAccessibility",
  /** Round 7: the welcome wizard has been completed at least once. */
  welcomeCompleted: "onboardingWelcomeCompleted",
};

function platform() {
  return process.platform;
}

/**
 * Current permission state for the platform.
 * @returns {{ screenRecording: "granted"|"denied"|"unknown"|"not-needed",
 *            accessibility: "granted"|"denied"|"unknown"|"not-needed" }}
 */
function permissionState() {
  if (platform() === "darwin") {
    return {
      screenRecording: screenRecordingStatus(),
      accessibility: accessibilityStatus(),
    };
  }
  // Windows / Linux: no OS permission is required for either capability.
  return { screenRecording: "not-needed", accessibility: "not-needed" };
}

function screenRecordingStatus() {
  try {
    const { systemPreferences } = require("electron");
    const st = systemPreferences.getMediaAccessStatus("screen");
    return st === "granted" ? "granted" : st === "denied" ? "denied" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * macOS Accessibility check: try a no-op AppleScript targeting System Events.
 * The FIRST real keystroke attempt is what triggers the OS prompt, which the
 * renderer initiates by calling runAccessibilityTest().
 */
function accessibilityStatus() {
  if (platform() !== "darwin") return "not-needed";
  try {
    execSync(`osascript -e 'tell application "System Events" to get name of first process'`, {
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "granted";
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    if (msg.includes("not allowed") || msg.includes("access for assistive devices")) return "denied";
    return "unknown";
  }
}

/**
 * Trigger the real OS Accessibility prompt: a keystroke via osascript is the
 * first action the OS treats as requiring Accessibility access.
 */
function runAccessibilityTest() {
  if (platform() !== "darwin") return { ok: true, triggered: false };
  try {
    execSync(`osascript -e 'tell application "System Events" to keystroke ""'`, {
      timeout: 10000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    log.info("[onboarding] accessibility test ran");
    return { ok: true, triggered: true, status: accessibilityStatus() };
  } catch (err) {
    log.warn("[onboarding] accessibility test failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err), status: accessibilityStatus() };
  }
}

/** Which onboarding screens are still pending? */
function pendingScreens() {
  const all = settings.all();
  const st = permissionState();
  const screens = [];
  if (st.screenRecording !== "granted" && st.screenRecording !== "not-needed" && !all[ACK_KEYS.screenRecording]) {
    screens.push({ id: "screen-recording", why: "Reading your screen (\"what's on my screen\")" });
  }
  if (st.accessibility !== "granted" && st.accessibility !== "not-needed" && !all[ACK_KEYS.accessibility]) {
    screens.push({ id: "accessibility", why: "Controlling the mouse and keyboard on your behalf" });
  }
  return screens;
}

function acknowledge(id) {
  if (id === "screen-recording") settings.setRaw(ACK_KEYS.screenRecording, true);
  if (id === "accessibility") settings.setRaw(ACK_KEYS.accessibility, true);
}

// ---------------------------------------------------------------------------
// Round 7: first-run welcome wizard
// ---------------------------------------------------------------------------

/**
 * Is this the very first run? The welcome wizard appears once per install
 * (tracked by `onboardingWelcomeCompleted` in settings.json).
 */
function isFirstRun() {
  const all = settings.all();
  return !all[ACK_KEYS.welcomeCompleted];
}

/** Mark the welcome wizard as done. */
function completeWizard() {
  settings.setRaw(ACK_KEYS.welcomeCompleted, true);
}

/**
 * What the wizard should show right now. The renderer drives the UI; this
 * simply says whether the welcome tour is due and how many permission
 * screens follow it. Steps are:
 *   welcome → api-key (renderer) → [screen-recording] → [accessibility] → done
 */
function wizardState() {
  const firstRun = isFirstRun();
  const pending = pendingScreens();
  return {
    firstRun,
    pending: pending,
    welcomeDue: firstRun,
  };
}

module.exports = { platform, permissionState, runAccessibilityTest, pendingScreens, acknowledge, isFirstRun, completeWizard, wizardState, ACK_KEYS };

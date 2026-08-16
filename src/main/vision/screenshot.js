"use strict";
// ----------------------------------------------------------------------------
// screenshot.js — cross-platform screenshot capture via Electron
// desktopCapturer (main process only).
//
// macOS: the OS requires an explicit "Screen Recording" permission grant.
//   - On < macOS 15 Sequoia it shows a system dialog on first access.
//   - On macOS 15+ the user must grant it in
//     System Settings > Privacy & Security > Screen Recording, then relaunch.
// We detect `denied`/`not-determined` via
// systemPreferences.getMediaAccessStatus('screen') and report it so the
// renderer can show setup instructions + a button to open System Settings.
//
// Windows / Linux: no extra permissioning is required; captures work OOTB.
// ----------------------------------------------------------------------------

const { desktopCapturer, systemPreferences } = require("electron");

const ACTION_ID = "vision:capture-screen";

/**
 * Detect the macOS Screen Recording permission status.
 * Returns one of:
 *   "granted"   — permission granted (or platform where it does not apply)
 *   "denied"    — permission explicitly denied
 *   "restricted" — admin-restricted (MDM)
 *   "prompt"    — not yet determined; OS may show a dialog on access
 *   "unknown"   — could not be determined (non-macOS or API unavailable)
 *
 * Note: on macOS 15+ the OS often reports `granted` even when the user never
 * granted it in the new panel; a failed capture there signals the same thing.
 */
function getScreenPermissionStatus() {
  if (process.platform !== "darwin") return "granted";
  try {
    const s = systemPreferences.getMediaAccessStatus("screen");
    if (s === "granted") return "granted";
    if (s === "denied") return "denied";
    if (s === "restricted") return "restricted";
    return s === "not-determined" ? "prompt" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Capture the primary screen as a PNG buffer using desktopCapturer.
 *
 * Returns { buffer, width, height, permissionMissing }
 *   - buffer:  PNG image buffer (Buffer)
 *   - width/height: natural pixel dimensions
 *   - permissionMissing: boolean — true when the OS permission is absent or
 *     could not be granted; the caller should surface setup instructions.
 */
async function captureScreen() {
  const status = getScreenPermissionStatus();
  const permissionMissing = status !== "granted";

  // Even when the OS claims "granted", an actual capture can fail on macOS 15+
  // if the new Screen Recording panel was never configured. Treat capture
  // failure as a permission hint too.
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 3840, height: 2160 },
    });
  } catch (err) {
    throw new Error(`Screenshot capture failed — screen access is blocked (${permissionMissing ? "Screen Recording permission" : "unknown cause"}). ${err?.message || ""}`.trim());
  }

  if (!sources || sources.length === 0) {
    throw new Error("No screens found — Screen Recording permission may be missing.");
  }

  // Prefer the primary display (id "screen:0:*") when available.
  const primary = sources.find((s) => s.id.startsWith("screen:0:")) || sources[0];
  const thumb = primary.thumbnail;

  // NativeImage has no raw PNG bytes on all platforms; encode PNG via
  // toPNG(). If unavailable, fall back to JPEG.
  const buffer = thumb.toPNG ? thumb.toPNG() : thumb.toJPEG(92);
  return {
    buffer,
    width: thumb.getSize().width,
    height: thumb.getSize().height,
    permissionMissing,
    status,
    sourceId: primary.id,
  };
}

/**
 * Open the macOS System Settings pane for Screen Recording.
 * Works on macOS 13+ (Ventura and later); falls back to the legacy Privacy
 * System Preferences URL on older releases.
 */
async function openScreenSettings() {
  if (process.platform !== "darwin") {
    return { ok: false, error: `Not applicable on ${process.platform} — screen access works without extra permissioning.` };
  }
  const { shell } = require("electron");
  // `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  // opens the exact Screen Recording list on macOS 13+.
  try {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
    return { ok: true, platform: "darwin" };
  } catch (err) {
    try {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      return { ok: true, platform: "darwin", note: "opened legacy privacy pane" };
    } catch (e2) {
      return { ok: false, error: String(e2?.message || e2) };
    }
  }
}

module.exports = { ACTION_ID, getScreenPermissionStatus, captureScreen, openScreenSettings };

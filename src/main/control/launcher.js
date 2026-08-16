// Nova — control/launcher.js
//
// Cross-platform application launcher (Level 1, SAFE):
//   macOS:   `open -a <App>` (works with display names, e.g. "Calculator")
//   Windows: resolved by friendly name if it looks like a known app, else
//            tries `start "" "<app>.exe"` via cmd; known apps map to their
//            executables so "open calculator" works without the user typing
//            "calc.exe".
//   Linux:   runs the app binary by name (e.g. gnome-calculator, kcalc);
//            known aliases are mapped.
//
// The launcher only STARTS applications — never reads or kills them.

const { execFile } = require("child_process");
const log = require("electron-log");

/** Friendly-name / alias mapping to real executables per OS. */
const KNOWN_APPS = {
  darwin: {
    calculator: "Calculator",
    calc: "Calculator",
    notes: "Notes",
    reminders: "Reminders",
    safari: "Safari",
    textedit: "TextEdit",
    terminal: "Terminal",
  },
  win32: {
    calculator: "calc.exe",
    calc: "calc.exe",
    notepad: "notepad.exe",
    paint: "mspaint.exe",
    terminal: "wt.exe",
  },
  linux: {
    calculator: "gnome-calculator",
    calc: "gnome-calculator",
    notepad: "gedit",
    notes: "gnome-text-editor",
    terminal: "gnome-terminal",
  },
};

function resolveApp(raw, os) {
  const key = String(raw || "").trim().toLowerCase();
  const map = KNOWN_APPS[os] || KNOWN_APPS.linux;
  if (map[key]) return { name: key, resolved: map[key] };
  return { name: raw.trim(), resolved: raw.trim() };
}

/**
 * Launch an application.
 * @param {string} app - friendly name or executable
 * @param {{ os?: string }} opts
 * @returns {{ resolved: string, launched: boolean }}
 */
function openApp(app, opts = {}) {
  const os = opts.os || process.platform;
  const { resolved, name } = resolveApp(app, os);
  return new Promise((resolve) => {
    const done = (launched, err) => {
      if (err) log.warn(`[control] launcher "${name}":`, String(err?.message || err).slice(0, 200));
      resolve({ resolved, name, launched });
    };

    if (os === "darwin") {
      execFile("open", ["-a", resolved], { timeout: 10000 }, (err) => done(!err, err));
      return;
    }
    if (os === "win32") {
      // `start` is a cmd built-in; run through cmd /c.
      execFile("cmd.exe", ["/c", "start", "", resolved], { timeout: 10000, windowsHide: true }, (err) => done(!err, err));
      return;
    }
    // linux and fallback: exec directly (unbufers output, don't wait).
    const proc = execFile(resolved, [], { timeout: 10000 }, (err) => done(!err, err));
    // Unref so a hanging child never pins the app's lifecycle.
    if (proc?.unref) proc.unref();
  });
}

module.exports = { openApp, resolveApp, KNOWN_APPS };

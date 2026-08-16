// Nova — control/input.js
//
// Wraps the input-simulation layer (@nut-tree-fork/nut-js) and registers every
// controllable primitive with the permission framework. Every action declares
// its risk level, a human description, an execute() path, and a simulate()
// dry-run path so the gate can describe the action in plain language and let
// the planner report "what WOULD happen" without moving the mouse.
//
// Risk classification (per the Stage 2 framework):
//   L0 READ       — move-cursor, cursor-position (inspect-only)
//   L1 SAFE       — open-app, wait-for-window
//   L2 REVERSIBLE — click, double-click, right-click, scroll, drag, type-text
//   L3 SENSITIVE  — press-keys for dangerous combos (close/quit shortcuts),
//                   submit keystrokes (Enter on forms)
//
// The layer below is a lazily-loaded optional dependency so the app still
// starts on systems where the native bindings fail to load; actions then
// surface a clear "input engine unavailable" error through the action log.

const log = require("electron-log");
const { registerAction } = require("../permissions/action-registry");

let engine = null;
let engineLoadError = null;

/**
 * Lazily load the nut.js engine. Cached after first (successful) load.
 * @returns {{ mouse, keyboard, screen, Key, Point, Button } | null}
 */
function getEngine() {
  if (engine) return engine;
  if (engineLoadError) return null;
  try {
    // eslint-disable-next-line global-require
    const { mouse, keyboard, screen, Point, Button, Key } = require("@nut-tree-fork/nut-js");
    engine = { mouse, keyboard, screen, Point, Button, Key };
    log.info("[control] input engine loaded (@nut-tree-fork/nut-js)");
    return engine;
  } catch (err) {
    engineLoadError = err;
    log.error("[control] input engine failed to load:", err?.message || err);
    return null;
  }
}

/** Inject a mock engine for headless tests. */
function setEngineForTesting(mock) {
  engine = mock;
  engineLoadError = null;
}

function requireEngine() {
  const eng = getEngine();
  if (!eng) throw new Error("The input engine is unavailable on this machine.");
  return eng;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Plain-language descriptions shared by execute and simulate. */
const describe = {
  moveCursor: (p) => ({
    title: `Nova wants to move the cursor to (${p.x}, ${p.y})`,
    body: `The mouse pointer will jump to coordinates x=${p.x}, y=${p.y}. No clicks are performed.`,
  }),
  click: (p) => ({
    title: `Nova wants to ${p.times > 1 ? `double-` : ""}click at (${p.x}, ${p.y})${p.label ? ` ("${p.label}")` : ""}`,
    body: `The mouse pointer will ${p.times > 1 ? "double-" : ""}click at coordinates x=${p.x}, y=${p.y}.`,
  }),
  rightClick: (p) => ({
    title: `Nova wants to right-click at (${p.x}, ${p.y})${p.label ? ` ("${p.label}")` : ""}`,
    body: `Opens the context menu at coordinates x=${p.x}, y=${p.y}.`,
  }),
  scroll: (p) => ({
    title: `Nova wants to scroll ${p.direction} by ${Math.abs(p.amount)} step(s)`,
    body: "The page or window under the cursor will scroll. No clicks are performed.",
  }),
  drag: (p) => ({
    title: `Nova wants to drag from (${p.fromX}, ${p.fromY}) to (${p.toX}, ${p.toY})`,
    body: "The mouse button will be held while moving the cursor — used for selecting or moving items.",
  }),
  typeText: (p) => ({
    title: `Nova wants to type "${p.text}"`,
    body: p.text.length > 60 ? `Keystrokes will be typed into the focused field (${p.text.length} characters).` : "Keystrokes will be typed into the focused field.",
  }),
  pressKeys: (p) => ({
    title: `Nova wants to press ${p.combo} at the keyboard`,
    body: p.combo.includes("Return") || p.combo.includes("Enter")
      ? "This submits/activates whatever the focused control responds to (e.g. a form or dialog)."
      : "Keyboard shortcut — may affect the focused application. Double-check before confirming.",
  }),
  openApp: (p) => ({
    title: `Nova wants to open ${p.appName || p.app}`,
    body: "The application will be launched in the usual way for this operating system.",
  }),
  waitForWindow: (p) => ({
    title: `Nova wants to wait for "${p.label || p.window}" to appear`,
    body: "Nova will take a screenshot and check the expected text is visible before continuing.",
  }),
};

function describeOf(name, payload) {
  const fn = describe[name];
  if (typeof fn === "function") {
    const d = fn(payload);
    if (payload?.__describe) return d;
    return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action registration
// ---------------------------------------------------------------------------

function registerControlActions() {
  /** Helper: register a physically-invasive control action (Private Mode blocks these). */
  function registerPhysicalAction(entry) {
    registerAction({ ...entry, physical: true });
  }

  registerAction({
    id: "control:cursor-position",
    level: 0,
    description: "read the current mouse cursor position",
    async execute() {
      const { screen } = requireEngine();
      return screen.mousePosition();
    },
    simulate(p) {
      if (p?.__describe) return { title: "Nova wants to read the cursor position", body: "This only reads coordinates; nothing moves." };
      return null;
    },
  });

  registerAction({
    id: "control:move-cursor",
    level: 0,
    description: "move the mouse cursor",
    async execute(p) {
      const { mouse } = requireEngine();
      await mouse.move(new (requireEngine().Point)(p.x, p.y));
      return { x: p.x, y: p.y };
    },
    simulate(p) {
      return describeOf("moveCursor", p);
    },
  });

  registerPhysicalAction({
    id: "control:left-click",
    level: 2,
    description: "click the mouse on the screen",
    async execute(p) {
      const { mouse } = requireEngine();
      await mouse.move(new (requireEngine().Point)(p.x, p.y));
      await mouse.leftClick(p.times || 1);
      return { x: p.x, y: p.y, times: p.times || 1 };
    },
    simulate(p) {
      return describeOf("click", p);
    },
  });

  registerPhysicalAction({
    id: "control:right-click",
    level: 2,
    description: "right-click to open a context menu",
    async execute(p) {
      const { mouse } = requireEngine();
      await mouse.move(new (requireEngine().Point)(p.x, p.y));
      await mouse.rightClick();
      return { x: p.x, y: p.y };
    },
    simulate(p) {
      return describeOf("rightClick", p);
    },
  });

  registerPhysicalAction({
    id: "control:double-click",
    level: 2,
    description: "double-click the mouse on the screen",
    async execute(p) {
      const { mouse } = requireEngine();
      await mouse.move(new (requireEngine().Point)(p.x, p.y));
      await mouse.leftClick(2);
      return { x: p.x, y: p.y };
    },
    simulate(p) {
      return describeOf("click", { ...p, times: 2 });
    },
  });

  registerPhysicalAction({
    id: "control:scroll",
    level: 2,
    description: "scroll the page or window under the cursor",
    async execute(p) {
      const { mouse } = requireEngine();
      const amount = p.amount || 1;
      if (p.direction === "up") await mouse.scrollUp(amount);
      else if (p.direction === "left") await mouse.scrollLeft(amount);
      else if (p.direction === "right") await mouse.scrollRight(amount);
      else await mouse.scrollDown(amount);
      return { direction: p.direction || "down", amount };
    },
    simulate(p) {
      return describeOf("scroll", p);
    },
  });

  registerPhysicalAction({
    id: "control:drag",
    level: 2,
    description: "drag the mouse across the screen",
    async execute(p) {
      const { mouse, Point } = requireEngine();
      const target = new Point(p.toX, p.toY);
      // nut.js drag(): press LEFT at the current position, then drag to the
      // target — so move to the start point first, then drag.
      await mouse.move(new Point(p.fromX, p.fromY));
      await mouse.drag(target);
      return { from: { x: p.fromX, y: p.fromY }, to: { x: p.toX, y: p.toY } };
    },
    simulate(p) {
      return describeOf("drag", p);
    },
  });

  registerPhysicalAction({
    id: "control:type-text",
    level: 2,
    description: "type text into the focused field",
    async execute(p) {
      const { keyboard } = requireEngine();
      await keyboard.type(p.text);
      return { text: p.text, length: p.text.length };
    },
    simulate(p) {
      return describeOf("typeText", p);
    },
  });

  registerPhysicalAction({
    id: "control:press-keys",
    level: 3,
    description: "press a keyboard shortcut that can trigger an irreversible action",
    async execute(p) {
      const { keyboard, Key } = requireEngine();
      const keys = (p.combo || "").split(/\s*[+ ]\s*/).filter(Boolean).map((k) => {
        if (k.length === 1 && /[A-Za-z0-9]/.test(k)) return Key[k.toUpperCase()] ?? Key[k];
        return Key[k] ?? k;
      });
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys);
      return { combo: p.combo };
    },
    simulate(p) {
      return describeOf("pressKeys", p);
    },
  });

  registerAction({
    id: "control:open-app",
    level: 1,
    description: "open an application",
    async execute(p) {
      const launcher = require("./launcher");
      const result = await launcher.openApp(p.app || p.appName, { os: process.platform });
      return { app: p.app || p.appName, ...result };
    },
    simulate(p) {
      return describeOf("openApp", p);
    },
  });

  registerAction({
    id: "control:wait-for-window",
    level: 1,
    description: "wait for a window and verify it with the screen reader",
    async execute(p) {
      const verify = require("./verify");
      return verify.verifyWindow({ label: p.label || p.window, contains: p.contains });
    },
    simulate(p) {
      return describeOf("waitForWindow", p);
    },
  });
}

module.exports = {
  registerControlActions,
  getEngine,
  setEngineForTesting,
  describe,
};

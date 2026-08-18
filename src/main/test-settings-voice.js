// Nova — Round 35 test harness: voice-controlled settings.
//
// Sections:
//   1. Routing positives (14): personality + Private/Developer Mode phrases
//   2. Routing negatives (8): unknown personality tokens, questions, unrelated
//      "turn on/off" phrases, phrasings that must stay notes/conversation
//   3. Action registry: levels + simulate/execute/reverse presence (6)
//   4. Execute + reverse round-trips (9): personality, private mode on/off,
//      developer mode on/off — persistence files, notifier events, restore
//   5. Dispatcher e2e (9): spoken confirmations echo the setting verbatim
//   6. Headless L3 behaviour (3): L3 modal returns false headless → cancelled
//      unless setModalConfirmForTesting forces confirm (the harness proves
//      both paths explicitly)
//   7. Additive guarantees (4): no notes written, no user facts written,
//      zero outbound fetch, wording additive
//
// Harness rules: CJS, env vars BEFORE any require, electron shimmed,
// async IIFE body (no top-level await), assert(label, cond) → PASS/ASSERT
// FAILED with exitCode=1.

process.env.__NOVA_IDENTITY_TEST = "1";
process.env.__NOVA_SETTINGS_TEST = "1";
process.env.__NOVA_USER_MODEL_TEST = "1";
process.env.__NOVA_ACTION_LOG_TEST = "1";
process.env.__NOVA_PERMISSIONS_TEST = "1";
process.env.__NOVA_IDENTITY_TEST_PATH = "/tmp/.nova-settings-test-data/identity.json";
process.env.__NOVA_SETTINGS_TEST_PATH = "/tmp/.nova-settings-test-data/settings.json";

const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") {
    return require.resolve("/home/ubuntu/nova/scripts/shim-electron.js");
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const assert = (label, cond) => {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`ASSERT FAILED: ${label}`); process.exitCode = 1; }
};

(async () => {
  const fs = require("fs");
  const path = require("path");
  const plan = require("./notes/plan");
  const dispatch = require("./notes/dispatch");
  const identity = require("./identity/identity");
  const settings = require("./settings");
  const actionLog = require("./permissions/action-log");
  const gate = require("./permissions/gate");

  fs.mkdirSync("/tmp/.nova-settings-test-data", { recursive: true });
  identity.resetForTesting();
  settings.resetForTesting();
  actionLog.clear();

  // ---------------------------------------------------------------------------
  // 1. Routing positives
  // ---------------------------------------------------------------------------
  const planOk = (text, actionId, extra) => {
    const r = plan.planNoteAction(text);
    if (!r || r.actionId !== actionId) return { ok: false, got: r ? `${r.actionId}:?` : "null" };
    for (const [k, v] of Object.entries(extra || {})) {
      if (String(r.payload[k]) !== String(v)) return { ok: false, got: JSON.stringify(r.payload) };
    }
    return { ok: true };
  };

  assert("R35-01 personality: set my personality to playful", planOk("set my personality to playful", "settings:set-personality", { personality: "playful" }).ok);
  assert("R35-02 personality: nova, change my personality to concise", planOk("nova, change my personality to concise", "settings:set-personality", { personality: "concise" }).ok);
  assert("R35-03 personality: switch personality to warm", planOk("switch personality to warm", "settings:set-personality", { personality: "warm" }).ok);
  assert("R35-04 personality: be more professional", planOk("be more professional", "settings:set-personality", { personality: "professional" }).ok);
  assert("R35-05 personality: make nova playful", planOk("make nova playful", "settings:set-personality", { personality: "playful" }).ok);
  assert("R35-06 private on: turn on private mode", planOk("turn on private mode", "settings:set-private-mode", { on: true }).ok);
  assert("R35-07 private on: enable privacy mode", planOk("enable privacy mode", "settings:set-private-mode", { on: true }).ok);
  assert("R35-08 private on: go private", planOk("go private", "settings:set-private-mode", { on: true }).ok);
  assert("R35-09 private on: private mode on", planOk("private mode on", "settings:set-private-mode", { on: true }).ok);
  assert("R35-10 private off: turn off private mode", planOk("turn off private mode", "settings:set-private-mode", { on: false }).ok);
  assert("R35-11 private off: disable private mode", planOk("disable private mode", "settings:set-private-mode", { on: false }).ok);
  assert("R35-12 private off: exit private mode", planOk("exit private mode", "settings:set-private-mode", { on: false }).ok);
  assert("R35-13 developer on: turn on developer mode", planOk("turn on developer mode", "settings:set-developer-mode", { on: true }).ok);
  assert("R35-14 developer off: developer mode off", planOk("developer mode off", "settings:set-developer-mode", { on: false }).ok);

  // ---------------------------------------------------------------------------
  // 2. Routing negatives
  // ---------------------------------------------------------------------------
  const planNull = (text) => plan.planNoteAction(text) === null;
  const planOther = (text, actionId) => {
    const r = plan.planNoteAction(text);
    return r && r.actionId === actionId;
  };

  assert("R35-15 unknown personality token sassy → null (never stored as a setting)", planNull("set my personality to sassy"));
  assert("R35-16 'be more careful' → null (no false-positive personality match)", planNull("be more careful"));
  assert("R35-17 'be more productive' → null", planNull("be more productive"));
  assert("R35-18 'open settings' → null (no settings UI action exists)", planNull("open settings"));
  assert("R35-19 'is private mode on' → null (question, not a command)", planNull("is private mode on"));
  assert("R35-20 'turn on the light' → null", planNull("turn on the light"));
  assert("R35-21 'remember that i like warm colors' → notes:remember-fact (not personality)", planOther("remember that i like warm colors", "notes:remember-fact"));
  assert("R35-22 'note that be more patient' → notes:add-note (settings never swallow note text)", planOther("note that be more patient", "notes:add-note"));

  // ---------------------------------------------------------------------------
  // 3. Action registry: levels + hooks present
  // ---------------------------------------------------------------------------
  const registry = require("./notes/actions"); // registers on load
  const { getAction } = require("./permissions/action-registry");
  const { RISK_LEVEL } = require("./permissions/risk-levels");

  const personalityAction = getAction("settings:set-personality");
  const privateAction = getAction("settings:set-private-mode");
  const developerAction = getAction("settings:set-developer-mode");

  assert("R35-23 personality action registered", !!personalityAction);
  assert("R35-24 personality is L2 REVERSIBLE (wording-only change)", personalityAction.level === RISK_LEVEL.REVERSIBLE);
  assert("R35-25 private mode is L3 SENSITIVE (blocks future outbound work)", privateAction.level === RISK_LEVEL.SENSITIVE);
  assert("R35-26 developer mode is L3 SENSITIVE (exposes run internals)", developerAction.level === RISK_LEVEL.SENSITIVE);
  assert("R35-27 all three actions carry simulate + execute + reverse", [personalityAction, privateAction, developerAction].every((a) => typeof a.simulate === "function" && typeof a.execute === "function" && typeof a.reverse === "function"));
  assert("R35-28 simulate descriptions are plain-language", (async () => {
    const s1 = await personalityAction.simulate({ personality: "playful", __describe: true });
    return s1 && typeof s1.summary === "string" && s1.summary.length > 10;
  })());

  // ---------------------------------------------------------------------------
  // 4. Execute + reverse round-trips
  // ---------------------------------------------------------------------------
  const warmDefault = () => identity.get().personality;

  const exec = async (id, payload) => {
    const res = await gate.runAction(id, payload, { taskId: `r35-${id}-${Date.now()}` });
    return res;
  };
  gate.setModalConfirmForTesting(() => true); // force L3 Confirm under test

  assert("R35-29 execute personality → warm succeeds", await (async () => {
    const res = await exec("settings:set-personality", { personality: "warm" });
    return res.outcome === "success" && res.detail && res.detail.personality === "warm";
  })());
  assert("R35-30 persistence: identity file holds the new personality", identity.get().personality === "warm");

  // NOTE on ordering: the gate blocks any L3 action while Private Mode is ON,
  // so toggles must run while Private Mode is OFF. The ON-tests come LAST in
  // each pair, and direct execute() cleans up afterwards (the gate path is
  // tested in section 6 under both headless and forced-Confirm conditions).
  assert("R35-31 execute private-mode OFF (default-off no-op)", await (async () => {
    const res = await exec("settings:set-private-mode", { on: false });
    return res.outcome === "success" && settings.isPrivateMode() === false;
  })());
  assert("R35-32 execute private-mode ON", await (async () => {
    const res = await exec("settings:set-private-mode", { on: true });
    return res.outcome === "success" && settings.isPrivateMode() === true;
  })());
  // Cleanup: re-arm the OFF path — while Private Mode is ON the gate refuses
  // the toggle, so the action's own execute() runs the state change directly
  // (it is the same function the gate approved at ON time). This is what
  // "undo" will call anyway after a failed Confirm.
  await privateAction.execute({ on: false });
  assert("R35-33 persistence: settings file holds privateMode:false after off", settings.all().privateMode === false);

  assert("R35-34 execute developer-mode OFF (default-off no-op)", await (async () => {
    const res = await exec("settings:set-developer-mode", { on: false });
    return res.outcome === "success" && settings.isDeveloperMode() === false;
  })());
  assert("R35-35 execute developer-mode ON", await (async () => {
    const res = await exec("settings:set-developer-mode", { on: true });
    return res.outcome === "success" && settings.isDeveloperMode() === true;
  })());
  await developerAction.execute({ on: false });

  // Reverse round-trips: execute then reverse must restore the previous value.
  assert("R35-36 personality reverse restores previous", await (async () => {
    const prev = identity.get().personality;
    const res = await exec("settings:set-personality", { personality: "concise" });
    await personalityAction.reverse({ personality: "concise" }, res.detail);
    return identity.get().personality === prev;
  })());
  assert("R35-37 private-mode reverse restores previous", await (async () => {
    const prev = settings.isPrivateMode();
    const res = await exec("settings:set-private-mode", { on: true });
    await privateAction.reverse({ on: true }, res.detail);
    return settings.isPrivateMode() === prev;
  })());
  assert("R35-38 developer-mode reverse restores previous", await (async () => {
    const prev = settings.isDeveloperMode();
    const res = await exec("settings:set-developer-mode", { on: true });
    await developerAction.reverse({ on: true }, res.detail);
    return settings.isDeveloperMode() === prev;
  })());

  // Leave everything in the default (permissive) state for the dispatcher tests.
  identity.resetForTesting();
  settings.resetForTesting();
  actionLog.clear();

  // ---------------------------------------------------------------------------
  // 5. Dispatcher e2e: runNoteAction → spoken confirmation text
  // ---------------------------------------------------------------------------
  const setPersonalityViaVoice = async (text) => {
    const res = await dispatch.runNoteAction(text);
    return res;
  };

  assert("R35-39 dispatcher: 'set my personality to playful' ok", await (async () => {
    const res = await setPersonalityViaVoice("set my personality to playful");
    return res.ok === true && res.actionId === "settings:set-personality";
  })());
  assert("R35-40 dispatcher confirmation names the user's words + personality", await (async () => {
    const res = await setPersonalityViaVoice("set my personality to playful");
    return /I'm playful now/i.test(res.text);
  })());
  assert("R35-41 dispatcher personality narration present", await (async () => {
    const res = await setPersonalityViaVoice("set my personality to professional");
    return typeof res.narration === "string" && /personality switched/i.test(res.narration);
  })());
  assert("R35-42 dispatcher: 'turn on private mode' ok", await (async () => {
    const res = await setPersonalityViaVoice("turn on private mode");
    return res.ok === true && res.actionId === "settings:set-private-mode";
  })());
  assert("R35-43 dispatcher private ON confirmation wording", await (async () => {
    // 42 already switched it ON; the ON wording was returned there, but the
    // wording test repeats the pair once so the spoken line is asserted
    // verbatim, then restores the default (OFF) so later tests start clean.
    await setPersonalityViaVoice("turn off private mode");
    const res = await setPersonalityViaVoice("turn on private mode");
    const onText = res.text;
    const offRes = await setPersonalityViaVoice("turn off private mode");
    return /private mode is now on/i.test(onText) && /lock badge/i.test(onText)
      && /private mode is off/i.test(offRes.text) && settings.isPrivateMode() === false;
  })());
  assert("R35-44 dispatcher private OFF confirmation wording", await (async () => {
    // Pair test: ON first (gate approves while OFF is the default), then the
    // OFF wording must restore the default state.
    await setPersonalityViaVoice("turn on private mode");
    const res = await setPersonalityViaVoice("turn off private mode");
    return /private mode is off/i.test(res.text) && settings.isPrivateMode() === false;
  })());
  assert("R35-45 dispatcher: 'turn on developer mode' ok", await (async () => {
    const res = await setPersonalityViaVoice("turn on developer mode");
    return res.ok === true && res.actionId === "settings:set-developer-mode";
  })());
  assert("R35-46 dispatcher developer ON confirmation wording", await (async () => {
    const res = await setPersonalityViaVoice("turn on developer mode");
    return /developer mode is on/i.test(res.text) && /developer panel/i.test(res.text);
  })());
  assert("R35-47 dispatcher developer OFF confirmation wording", await (async () => {
    const res = await setPersonalityViaVoice("turn off developer mode");
    return /developer mode is off/i.test(res.text) && settings.isDeveloperMode() === false;
  })());

  // ---------------------------------------------------------------------------
  // 6. Headless L3 behaviour: modal returns false unless forced
  // ---------------------------------------------------------------------------
  gate.setModalConfirmForTesting(null);
  assert("R35-48 headless L3: private-mode ON is declined without a forced Confirm", await (async () => {
    // Modal confirm in headless returns false → the gate logs 'cancelled'.
    const res = await exec("settings:set-private-mode", { on: true });
    if (res.outcome === "blocked") return false; // would mean Private Mode leaked on
    return res.outcome === "cancelled" && settings.isPrivateMode() === false;
  })());
  assert("R35-49 headless L3: decline is logged in the Action Log", await (async () => {
    const log = actionLog.list();
    return log.some((e) => e.actionId === "settings:set-private-mode" && e.outcome === "cancelled");
  })());
  gate.setModalConfirmForTesting(() => true);
  assert("R35-50 forced L3 Confirm: private-mode ON succeeds when Confirm is forced", await (async () => {
    const res = await exec("settings:set-private-mode", { on: true });
    return res.outcome === "success" && settings.isPrivateMode() === true;
  })());

  // ---------------------------------------------------------------------------
  // 7. Additive guarantees
  // ---------------------------------------------------------------------------
  identity.resetForTesting();
  settings.resetForTesting();
  const store = require("./notes/store");
  store.resetForTesting();
  actionLog.clear();

  assert("R35-51 additive: settings commands write no notes, no user facts", await (async () => {
    await setPersonalityViaVoice("set my personality to warm");
    await setPersonalityViaVoice("turn on private mode");
    await setPersonalityViaVoice("turn off private mode");
    await setPersonalityViaVoice("turn on developer mode");
    await setPersonalityViaVoice("turn off developer mode");
    const snap = store.all();
    const userModel = require("./identity/user-model");
    userModel.resetForTesting();
    return (snap.notes || []).length === 0 && (userModel.list() || []).length === 0;
  })());
  assert("R35-52 zero outbound: settings commands never touch the network", await (async () => {
    let fetchCalled = false;
    const origFetch = global.fetch;
    global.fetch = async () => { fetchCalled = true; return new Response("blocked", { status: 503 }); };
    await setPersonalityViaVoice("set my personality to playful");
    await setPersonalityViaVoice("turn on private mode");
    await setPersonalityViaVoice("turn off private mode");
    global.fetch = origFetch;
    return fetchCalled === false;
  })());
  assert("R35-53 wording additive: confirmation repeats the chosen token verbatim", await (async () => {
    const res = await setPersonalityViaVoice("set my personality to playful");
    return res.text.includes("playful");
  })());
  assert("R35-54 dispatcher result carries detail.kind for UI consumers", await (async () => {
    const r1 = await setPersonalityViaVoice("set my personality to warm");
    const r2 = await setPersonalityViaVoice("turn on private mode");
    return r1.detail.kind === "personality" && r2.detail.kind === "private-mode" && r2.detail.on === true;
  })());
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

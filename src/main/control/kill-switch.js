// Nova — control/kill-switch.js
//
// The hard kill-switch for any in-progress control sequence (Stage 4 req 4):
//   - A shared SequenceController instance: start / step / abort.
//   - Every step checks isAborted before acting; abort mid-step stops the
//     sequence immediately and logs remaining steps as cancelled.
//   - Global hotkey Ctrl+Shift+Escape (both platforms) calls abort().
//   - Renderer exposes a visible STOP button wired to the same abort path.
//   - The existing "Nova stop" voice phrase is reused in the renderer to
//     call the same IPC, so barge-in and kill-switch share one surface.

const log = require("electron-log");

const STATE_IDLE = "idle";
const STATE_REVIEWING = "reviewing";
const STATE_RUNNING = "running";
const STATE_DONE = "done";

class SequenceController {
  constructor() {
    this.planId = null;
    this.state = STATE_IDLE;
    this._aborted = false;
    this._emit = null; // progress emitter function set by control-runner
  }

  get isRunning() {
    return this.state === STATE_RUNNING;
  }

  get isAborted() {
    return this._aborted;
  }

  /** Renderer-bound progress emitter: (event) => void. */
  setEmitter(fn) {
    this._emit = fn;
  }

  emit(event) {
    if (typeof this._emit === "function") {
      try { this._emit(event); } catch (err) { log.error("[control] progress emit failed:", err?.message); }
    }
  }

  /** User has been shown the plan; sequence will start on their confirmation. */
  reviewing(planId) {
    this.planId = planId;
    this.state = STATE_REVIEWING;
    this._aborted = false;
    this.emit({ type: "state", state: STATE_REVIEWING, planId });
  }

  start() {
    if (this.state !== STATE_REVIEWING) return false;
    this.state = STATE_RUNNING;
    this._aborted = false;
    this.emit({ type: "state", state: STATE_RUNNING, planId: this.planId });
    return true;
  }

  /** Hard kill: callable any time — including mid-step. */
  abort(reason = "user abort") {
    if (this.state === STATE_IDLE || this.state === STATE_DONE) return false;
    this._aborted = true;
    const wasRunning = this.state === STATE_RUNNING;
    this.state = STATE_DONE;
    this.emit({ type: "state", state: "aborted", reason, wasRunning });
    log.info(`[control] kill-switch triggered: ${reason} (wasRunning=${wasRunning})`);
    return true;
  }

  finish() {
    this.state = STATE_DONE;
    this.emit({ type: "state", state: STATE_DONE, planId: this.planId });
  }

  /** Throwing helper steps call before doing anything: guarantees aborts win. */
  guardStep(stepId) {
    if (this._aborted) {
      this.emit({ type: "step", stepId, status: "aborted", note: "sequence was stopped by the kill-switch" });
      throw new SequenceAbortedError();
    }
  }

  reset() {
    this.planId = null;
    this.state = STATE_IDLE;
    this._aborted = false;
  }
}

class SequenceAbortedError extends Error {
  constructor() {
    super("control sequence aborted");
    this.name = "SequenceAbortedError";
  }
}

/** Singleton used by the control runner and the hotkey handler. */
const sequence = new SequenceController();

module.exports = { SequenceController, SequenceAbortedError, sequence, STATE_IDLE, STATE_REVIEWING, STATE_RUNNING, STATE_DONE };

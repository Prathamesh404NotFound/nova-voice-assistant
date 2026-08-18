/**
 * Wake Word Detection Module for Nova
 * =====================================
 * Uses Porcupine (Picovoice) via @picovoice/porcupine-web (WebAssembly/IIFE)
 * to detect "Hey Nova" offline in the renderer process.
 *
 * If no Picovoice AccessKey is configured, falls back gracefully to
 * the existing energy-gate VAD (tap-to-arm) behavior.
 *
 * Requires porcupine-web IIFE to be loaded BEFORE this script in index.html.
 * Exposes window.NovaWakeWordDetector class.
 *
 * Settings (from window.nova.settings or passed as opts):
 * - wakeWordEnabled: boolean (default false, opt-in)
 * - porcupineAccessKey: string (from Picovoice Console, free tier)
 * - wakeWordKeyword: string (default "NOVA" or "COMPUTER")
 * - wakeWordSensitivity: number 0-1 (default 0.6)
 */

(function () {
  "use strict";

  const PORCUPINE_FRAME_LENGTH = 512; // samples at 16kHz = 32ms

  class NovaWakeWordDetector {
    constructor(opts = {}) {
      this.enabled = opts.enabled || false;
      this.accessKey = opts.accessKey || "";
      this.keyword = opts.keyword || "NOVA";
      this.sensitivity = opts.sensitivity || 0.6;
      this.porcupine = null;
      this.audioContext = null;
      this.processor = null;
      this.onDetected = opts.onDetected || (() => {});
      this.onError = opts.onError || ((e) => console.warn("[WakeWord]", e));
      this.running = false;
    }

    get isActive() {
      return this.running && !!this.porcupine;
    }

    /**
     * Initialize the Porcupine engine (loads WASM, prepares keyword).
     * Returns true if ready, false if disabled/failed (graceful fallback).
     */
    async init() {
      if (!this.enabled || !this.accessKey) {
        console.info("[WakeWord] Disabled or no AccessKey — using tap-to-arm VAD.");
        return false;
      }

      if (typeof PorcupineWeb === "undefined" || !PorcupineWeb.Porcupine) {
        this.onError("PorcupineWeb not loaded (check script tag order)");
        return false;
      }

      try {
        this.porcupine = await PorcupineWeb.Porcupine.create({
          accessKey: this.accessKey,
          keywords: [
            { keyword: this.keyword, sensitivity: this.sensitivity },
          ],
        });
        console.info(`[WakeWord] Porcupine initialized — listening for "${this.keyword}"`);
        return true;
      } catch (err) {
        this.onError(`Porcupine init failed: ${err.message}. Falling back to tap-to-arm.`);
        this.porcupine = null;
        return false;
      }
    }

    /**
     * Start processing audio from a MediaStream.
     * Must be called after init() succeeds.
     */
    async start(stream) {
      if (!this.porcupine) return false;

      try {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000,
        });
        const source = this.audioContext.createMediaStreamSource(stream);

        const bufferSize = PORCUPINE_FRAME_LENGTH * 2;
        this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

        this.processor.onaudioprocess = (ev) => {
          const input = ev.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          try {
            const keywordIndex = this.porcupine.process(int16);
            if (keywordIndex >= 0) {
              console.info("[WakeWord] Detected:", this.keyword);
              this.onDetected();
            }
          } catch (procErr) {
            // Non-fatal — skip this frame
            console.warn("[WakeWord] process error:", procErr.message);
          }
        };

        source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
        this.running = true;
        return true;
      } catch (err) {
        this.onError(`Audio start failed: ${err.message}`);
        this.running = false;
        return false;
      }
    }

    /** Stop audio processing (keeps Porcupine loaded for quick restart) */
    stop() {
      this.running = false;
      if (this.processor) {
        this.processor.disconnect();
        this.processor.onaudioprocess = null;
        this.processor = null;
      }
      if (this.audioContext && this.audioContext.state !== "closed") {
        this.audioContext.close();
        this.audioContext = null;
      }
    }

    /** Full teardown */
    async destroy() {
      this.stop();
      if (this.porcupine) {
        try {
          await this.porcupine.release();
        } catch (e) {
          console.warn("[WakeWord] release error:", e.message);
        }
        this.porcupine = null;
      }
    }
  }

  // Expose globally for app.js
  window.NovaWakeWordDetector = NovaWakeWordDetector;
})();

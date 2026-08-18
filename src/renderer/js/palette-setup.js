/**
 * Nova Command Palette setup (Round 10)
 * Builds the catalog from main-process actions + local UI affordances and
 * wires Cmd/Ctrl+K to open it. Loaded by app.js after boot.
 *
 * Catalog rules:
 *  - Main-process actions keep their declared risk level (L0–L4); running one
 *    goes through the same confirmation gates as any other path — the palette
 *    is a launcher, not a bypass.
 *  - Local UI affordances (panels, exports) are Level 0 in the launcher view.
 */

(function () {
  "use strict";

  /** Register Ctrl+K / Cmd+K to open the palette. Returns a dispose fn. */
  function bindPaletteHotkey(openFn) {
    const onKey = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")) {
        ev.preventDefault();
        openFn();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }

  /**
   * Construct the palette.
   * @param {object} ctx — { el, setSidePanel, runKbCommand, submitMessage,
   *        refreshPermPanel, checkScreenPermission, exportLog, refreshNotes,
   *        refreshAuto, startListening, stopSpeaking, getAccessKeyStatus }
   */
  function createPalette(ctx) {
    let catalog = [];
    let ready = Promise.resolve();

    // 1) Local UI affordances — always available, no network, no gates.
    catalog.push({
      label: "Open side panel", hint: "history + tools", level: 0,
      run: () => ctx.setSidePanel(true),
    });
    catalog.push({
      label: "Close side panel", level: 0,
      run: () => ctx.setSidePanel(false),
    });
    catalog.push({
      label: "Export action log as JSON", hint: "every action Nova took", level: 0,
      run: () => ctx.exportLog(),
    });
    catalog.push({
      label: "Clear action log", hint: "confirm via toast first", level: 0,
      run: async () => {
        try { await window.nova.clearActionLog(); ctx.refreshPermPanel(); } catch { /* toast path elsewhere */ }
      },
    });
    catalog.push({
      label: "Refresh free-model list", hint: "OpenRouter rotation", level: 0,
      run: () => { window.nova.refreshModels?.().catch(() => {}); },
    });
    catalog.push({
      label: "Toggle listening / stop speaking", hint: "like clicking the orb", level: 0,
      run: () => {
        if (ctx.isSpeaking) { ctx.stopSpeaking(); }
        else { ctx.startListening(); }
      },
    });
    catalog.push({
      label: "Open macOS Screen Recording settings", hint: "permission help", level: 0,
      run: () => { window.nova.openScreenSettings?.().catch(() => {}); },
    });

    // 2) Voice-pipeline commands — reuse the shared chat entry point.
    catalog.push({
      label: "Ask Nova anything…", hint: "runs as typed input", level: 1,
      run: () => {
        const q = prompt("Ask Nova:");
        if (q?.trim()) ctx.submitMessage(q.trim(), "palette");
      },
    });
    catalog.push({
      label: "Add folder to knowledge base", hint: "local index (L2 gate in main)", level: 2,
      run: () => ctx.runKbCommand("add this folder to my knowledge base", { pickDialog: true }),
    });
    catalog.push({
      label: "Search my knowledge base…", hint: "ask about indexed docs", level: 1,
      run: () => {
        const q = prompt("Search the knowledge base for:");
        if (q?.trim()) ctx.runKbCommand("search my kb for " + q.trim());
      },
    });

    // 3) Main-process actions (permission framework), fetched async.
    ready = window.nova.getActions?.().then((actions) => {
      for (const a of actions || []) {
        // Skip demo harness actions in production UI feel but keep them
        // discoverable since they drive the confirmation demos.
        if (a.physical) continue;
        const desc = typeof a.description === "string" ? a.description : "";
        const [title, hint] = desc.split(" — ").map((s) => (s || "").trim());
        catalog.push({
          label: title || a.id,
          hint: hint || a.id,
          level: a.level ?? 2,
          run: async () => {
            try {
              const payload = a.id === "demo:rename-file" ? { from: "report.txt", to: "report-final.txt" } : {};
              const res = await window.nova.runAction(a.id, payload, { dryRun: false });
              if (ctx.onActionRun) ctx.onActionRun(`${a.id} → ${res.outcome}`);
              if (ctx.refreshPermPanel) ctx.refreshPermPanel();
            } catch (err) {
              if (ctx.onActionRun) ctx.onActionRun(`Action failed: ${err?.message || err}`);
            }
          },
        });
      }
    }).catch(() => {});

    return {
      open() {
        // Wait for the async catalog merge, but never block the UX forever.
        ready.catch(() => {}).then(() => {
          if (!window.NovaCommandPalette) return;
          new window.NovaCommandPalette({
            items: catalog,
            onRun: (item) => { try { item.run(); } catch { /* keep palette closed */ } },
          }).open();
        });
      },
    };
  }

  window.NovaPaletteSetup = { bindPaletteHotkey, createPalette };
})();

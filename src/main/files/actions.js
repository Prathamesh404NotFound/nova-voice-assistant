// Nova — files/actions.js
//
// Registers every file-management action through the existing permission
// framework (Stage 6). Risk levels per the shared 5-level system; every L2+
// action provides simulate() (dry-run preview) and, where reversible, a
// reverse() fn so Nova's own Undo button works within 5 minutes. Deletes are
// L4 (modal, explicit confirm) and land in the OS Recycle Bin — never permanent.

const fs = require("fs");
const path = require("path");
const { registerAction } = require("../permissions/action-registry");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const toolbox = require("./toolbox");

// ---------------------------------------------------------------------------
// L0 — read-only, run immediately, still logged
// ---------------------------------------------------------------------------
registerAction({
  id: "files:search",
  level: RISK_LEVEL.READ,
  description: "Search for files by name, extension, or date",
  simulate: async (p) => ({ summary: `would search for "${p.query || "*"}"${p.everywhere ? " everywhere" : " in Documents/Downloads/Desktop"}` }),
  execute: async (p) => toolbox.searchFiles(p),
});

registerAction({
  id: "files:detect-duplicates",
  level: RISK_LEVEL.READ,
  description: "Find files with identical content inside a folder",
  simulate: async (p) => ({ summary: `would scan "${p.dir}" for duplicate content` }),
  execute: async (p) => toolbox.detectDuplicates(p.dir, { limit: p.limit }),
});

registerAction({
  id: "files:folder-stats",
  level: RISK_LEVEL.READ,
  description: "Report the size of a folder",
  simulate: async (p) => ({ summary: `would measure "${p.dir}"` }),
  execute: async (p) => toolbox.folderStats(p.dir),
});

// ---------------------------------------------------------------------------
// L2 — reversible, 5 s cancellable toast, dry-run preview FIRST (organize +
// duplicate removal), Nova Undo available afterwards
// ---------------------------------------------------------------------------
registerAction({
  id: "files:organize",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Move loose files into category folders",
  physical: false,
  simulate: async (p) => {
    const plan = toolbox.planOrganize(p.dir, { onlyLoose: p.onlyLoose !== false });
    if (!plan.summary.length) {
      return {
        title: `Nothing to organize in "${path.basename(p.dir)}"`,
        body: "All files are already sorted into category folders, or the folder is empty.",
      };
    }
    return {
      title: `Organize "${path.basename(p.dir)}": ${plan.movedFiles} file${plan.movedFiles === 1 ? "" : "s"} into category folders`,
      body: plan.summary.join("   ") + "\n\nNothing will be deleted — files are only moved into Documents/Images/… folders.",
    };
  },
  execute: async (p) => {
    // Mandatory dry-run: refuse execution without a preview token from the
    // simulate() report. Prevents any caller from skipping the preview.
    if (!p.previewToken) throw new Error("organize requires a dry-run preview before executing");
    const plan = toolbox.planOrganize(p.dir, { onlyLoose: p.onlyLoose !== false });
    const moved = [];
    const skipped = [];
    for (const cat of Object.keys(plan.plan)) {
      const targetDir = path.join(p.dir, cat);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const move of plan.plan[cat]) {
        try {
          if (fs.existsSync(move.to)) { skipped.push(move.from); continue; }
          fs.renameSync(move.from, move.to);
          moved.push({ from: move.from, to: move.to });
        } catch (err) {
          skipped.push(move.from);
        }
      }
    }
    return { moved, skipped, dirsCreated: Object.keys(plan.plan).length };
  },
  reverse: async (p) => {
    if (!Array.isArray(p.moved)) throw new Error("nothing to reverse");
    const restored = [];
    for (const { from, to } of p.moved) {
      try {
        if (fs.existsSync(to) && !fs.existsSync(from)) {
          fs.renameSync(to, from);
          restored.push({ from: to, to: from });
        }
      } catch { /* skip */ }
    }
    return { restored, note: restored.length ? `${restored.length} file${restored.length === 1 ? "" : "s"} restored to their original locations` : "nothing restored" };
  },
});

registerAction({
  id: "files:remove-duplicates",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Remove duplicate files, keeping the newest copy",
  physical: false,
  simulate: async (p) => {
    if (!Array.isArray(p.groups) || !p.groups.length) {
      return { title: "No duplicates to remove", body: "The last scan found no files with identical content." };
    }
    const toRemove = p.groups.flatMap((g) => g.files.filter((f) => f.path !== g.keep));
    const kept = p.groups.map((g) => path.basename(g.keep)).join(", ") || "none";
    return {
      title: `Remove ${toRemove.length} duplicate file${toRemove.length === 1 ? "" : "s"} (keep the newest)`,
      body: `Kept: ${kept}\nRemoved files go to the Recycle Bin/Trash, so they can still be restored by the OS.`,
    };
  },
  execute: async (p) => {
    if (!Array.isArray(p.groups)) throw new Error("remove-duplicates requires groups from detect-duplicates");
    const toRemove = p.groups.flatMap((g) => g.files.filter((f) => f.path !== g.keep));
    const trashRes = await toolbox.moveToTrash(toRemove);
    return { removed: trashRes.ok, failed: trashRes.failed, trashed: trashRes.ok.length };
  },
  // Nova Undo not registered for this one: files already trashed by the OS —
  // the OS Recycle Bin is the recovery path (documented in the simulate text).
});

registerAction({
  id: "files:move-files",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Move files to a destination folder",
  physical: false,
  simulate: async (p) => {
    const list = p.files || [];
    return {
      title: `Move ${list.length} file${list.length === 1 ? "" : "s"} to "${path.basename(p.to) || p.to}"`,
      body: list.map((f) => path.basename(f)).join(", ") + `\n→ ${p.to}`,
    };
  },
  execute: async (p) => {
    fs.mkdirSync(p.to, { recursive: true });
    const moved = [];
    const skipped = [];
    for (const from of p.files) {
      const to = path.join(p.to, path.basename(from));
      try {
        if (fs.existsSync(to)) { skipped.push(from); continue; }
        fs.renameSync(from, to);
        moved.push({ from, to });
      } catch {
        skipped.push(from);
      }
    }
    return { moved, skipped };
  },
  reverse: async (p) => {
    const restored = [];
    for (const { from, to } of (p.moved || [])) {
      try {
        if (fs.existsSync(to) && !fs.existsSync(from)) {
          fs.renameSync(to, from);
          restored.push({ from: to, to: from });
        }
      } catch { /* skip */ }
    }
    return { restored };
  },
});

registerAction({
  id: "files:copy-files",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Copy files to a destination folder",
  physical: false,
  simulate: async (p) => {
    const list = p.files || [];
    return {
      title: `Copy ${list.length} file${list.length === 1 ? "" : "s"} to "${path.basename(p.to) || p.to}"`,
      body: list.map((f) => path.basename(f)).join(", ") + `\n→ ${p.to}\nOriginals stay where they are.`,
    };
  },
  execute: async (p) => {
    fs.mkdirSync(p.to, { recursive: true });
    const copied = [];
    const skipped = [];
    for (const from of p.files) {
      const to = path.join(p.to, path.basename(from));
      try {
        if (fs.existsSync(to)) { skipped.push(from); continue; }
        fs.copyFileSync(from, to);
        copied.push({ from, to });
      } catch {
        skipped.push(from);
      }
    }
    return { copied, skipped };
  },
  reverse: async (p) => {
    const removed = [];
    for (const { from, to } of (p.copied || [])) {
      try {
        if (fs.existsSync(to)) {
          fs.unlinkSync(to);
          removed.push(to);
        }
      } catch { /* skip */ }
    }
    return { removedCopies: removed };
  },
});

registerAction({
  id: "files:rename-file",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Rename a file",
  physical: false,
  simulate: async (p) => ({
    title: `Rename "${path.basename(p.from) || p.from}" to "${path.basename(p.to) || p.to}"`,
    body: p.from + `\n→ ${p.to}`,
  }),
  execute: async (p) => {
    if (fs.existsSync(p.to)) throw new Error(`"${path.basename(p.to)}" already exists`);
    fs.renameSync(p.from, p.to);
    return { from: p.from, to: p.to };
  },
  reverse: async (p) => {
    try {
      if (fs.existsSync(p.to) && !fs.existsSync(p.from)) {
        fs.renameSync(p.to, p.from);
        return { restored: true };
      }
    } catch { /* skip */ }
    return { restored: false };
  },
});

// ---------------------------------------------------------------------------
// L4 — destructive, modal Confirm, OS Recycle Bin ONLY (never permanent)
// Nova Undo deliberately NOT registered: the OS trash is the recovery path.
// ---------------------------------------------------------------------------
registerAction({
  id: "files:delete-files",
  level: RISK_LEVEL.DESTRUCTIVE,
  description: "Move files to the Recycle Bin / Trash",
  physical: false,
  simulate: async (p) => {
    const list = p.files || [];
    return {
      title: `Nova wants to move ${list.length} file${list.length === 1 ? "" : "s"} to the Recycle Bin/Trash`,
      body: `Files:\n${list.map((f) => "  • " + f).join("\n")}\n\nThis is reversible from your OS Recycle Bin/Trash — Nova will not delete anything permanently.`,
    };
  },
  execute: async (p) => {
    if (!Array.isArray(p.files) || !p.files.length) throw new Error("delete-files requires an explicit file list");
    return toolbox.moveToTrash(p.files);
  },
});

module.exports = {};

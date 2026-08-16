// Nova — test harness: dummy actions to verify the confirmation flows.
//
// Registers 4 fake actions covering every gate path:
//   demo:read-files        → Level 0 (READ)        → runs immediately
//   demo:open-app          → Level 1 (SAFE)        → runs immediately
//   demo:rename-file       → Level 2 (REVERSIBLE)  → 5 s toast, cancellable
//   demo:send-message      → Level 3 (SENSITIVE)   → modal Confirm
//   demo:delete-files      → Level 4 (DESTRUCTIVE) → modal Confirm
//
// No real file-system / network / input tools live in this stage —
// these are stand-ins so the gate, log, and dry-run paths can be exercised.

const { registerAction } = require("./action-registry");

registerAction({
  id: "demo:read-files",
  level: 0,
  description: "Read the list of files on the desktop (demo)",
  execute: async () => ({ files: ["demo-file-1.txt", "demo-file-2.txt"] }),
});

registerAction({
  id: "demo:open-app",
  level: 1,
  description: "Open the Calculator app (demo)",
  execute: async (payload) => ({ opened: payload.app || "Calculator" }),
});

registerAction({
  id: "demo:rename-file",
  level: 2,
  description: "Rename a file",
  execute: async (payload) => ({ renamed: { from: payload.from, to: payload.to } }),
  // Undo: rename the file back to its original name.
  reverse: async (payload) => ({ renamedBack: { from: payload.to, to: payload.from } }),
  simulate: async (payload) => {
    if (payload?.__describe) {
      return {
        title: `Nova wants to rename "${payload?.from || "file.txt"}" to "${payload?.to || "new-file.txt"}"`,
        body: "This is reversible — you can rename it back. Nova will proceed automatically unless you cancel within 5 seconds.",
      };
    }
    return { wouldRename: 1, from: payload.from, to: payload.to };
  },
});

// demo:create-file — Level 2 with NO reverse fn: an irreversible stand-in so the
// undo tracker correctly ignores it (Undo stays disabled) and the demo covers
// every gate path.
registerAction({
  id: "demo:create-file",
  level: 2,
  description: "Create an empty file (demo)",
  execute: async (payload) => ({ created: payload.path || "file" }),
  simulate: async (payload) => {
    if (payload?.__describe) {
      return {
        title: `Nova wants to create "${payload?.path || "file"}"`,
        body: "This cannot be undone in this demo. Nova will proceed automatically unless you cancel within 5 seconds.",
      };
    }
    return { wouldCreate: 1, path: payload?.path };
  },
});

// demo:move-file — same Level 2 gate path as rename, with its own undo (move back).
registerAction({
  id: "demo:move-file",
  level: 2,
  description: "Move a file",
  execute: async (payload) => ({ moved: { from: payload.from, to: payload.to } }),
  // Undo: move the file back to its original location.
  reverse: async (payload) => ({ movedBack: { from: payload.to, to: payload.from } }),
  simulate: async (payload) => {
    if (payload?.__describe) {
      return {
        title: `Nova wants to move "${payload?.from || "file.txt"}" to "${payload?.to || "new-location/"}"`,
        body: "This is reversible — you can move it back. Nova will proceed automatically unless you cancel within 5 seconds.",
      };
    }
    return { wouldMove: 1, from: payload.from, to: payload.to };
  },
});

registerAction({
  id: "demo:send-message",
  level: 3,
  description: "Send a message",
  execute: async (payload) => ({ sent: payload.message }),
  simulate: async (payload) => {
    if (payload?.__describe) {
      return {
        title: `Nova wants to send a message`,
        body: `Message: "${payload?.message || ""}"\nThis cannot be recalled once sent. Confirm to proceed.`,
      };
    }
    return { wouldSend: 1, preview: payload?.message };
  },
});

registerAction({
  id: "demo:delete-files",
  level: 4,
  description: "Delete files",
  execute: async (payload) => ({ deleted: payload.files || [] }),
  simulate: async (payload) => {
    if (payload?.__describe) {
      const files = payload?.files || ["old-file-1.txt", "old-file-2.txt", "old-file-3.txt"];
      return {
        title: `Nova wants to delete ${files.length} file${files.length === 1 ? "" : "s"} in ~/Downloads/old`,
        body: `Files:\n${files.map((f) => "  • " + f).join("\n")}\nThis is permanent. Confirm to proceed.`,
      };
    }
    return { wouldDelete: (payload?.files || []).length, files: payload?.files };
  },
});

module.exports = {};

// Nova — Round 16 history export tests.
// history-export.js is a renderer IIFE (window.NovaHistoryExport) that only
// uses standard browser APIs (Blob, URL.createObjectURL, createElement). We
// shim those, load the module source via new Function, and exercise the
// Markdown rendering, escaping, filename suggestion, download plumbing, and
// the save-as-note IPC contract. No Electron needed.
const fs = require("fs");
const path = require("path");

// ---------- minimal browser shims ----------
global.window = global;
let createdAnchor = null;
const createdBlobs = [];
global.document = {
  createElement: () => {
    createdAnchor = { href: null, download: null, _clicked: false, remove: () => {} };
    createdAnchor.click = () => { createdAnchor._clicked = true; };
    return createdAnchor;
  },
  body: { appendChild: (a) => { a._appended = true; } },
};
global.URL = {
  _urls: {},
  createObjectURL: (blob) => {
    const u = "blob:fake/" + Math.random().toString(36).slice(2);
    global.URL._urls[u] = blob;
    return u;
  },
  revokeObjectURL: () => {},
};
global.Blob = class FakeBlob {
  constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ""; }
};

const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "history-export.js"), "utf8");
new Function("window", src)(global);
const E = window.NovaHistoryExport;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}: ${err.message}`); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
const fixedNow = new Date(Date.UTC(2026, 7, 18, 12, 0, 0)); // 2026-08-18T12:00:00Z

const sample = [
  { role: "user", text: "what's on my task list?", src: "voice" },
  { role: "nova", text: "You have 3 tasks: buy milk, call mom, finish the report.", src: "nova",
    kbSources: [{ file: "/home/me/notes/todo.txt", title: "todo.txt" }] },
  { role: "user", text: "pipe | and backtick ` trouble?", src: "voice" },
];

console.log("History export tests");

// 1. Header + body rendering.
check("transcript renders header and all messages", () => {
  const mdText = E.renderMarkdown(sample, { now: fixedNow, appName: "Nova" });
  eq(mdText.includes("# Nova session transcript"), true, "title");
  eq(mdText.includes("Exported on 2026-08-18 12:00:00"), true, "export stamp");
  eq(mdText.includes("## 1. You — via voice"), true, "user entry");
  eq(mdText.includes("## 2. Nova"), true, "nova entry");
  eq(mdText.includes("3 messages"), true, "count note");
});

// 2. Markdown-dangerous characters are escaped.
check("pipe and backtick get escaped", () => {
  const mdText = E.renderMarkdown(sample, { now: fixedNow });
  eq(mdText.includes("\\|"), true, "pipe escaped");
  eq(mdText.includes("\\`"), true, "backtick escaped");
  eq(mdText.includes("`/home/me/notes/todo.txt`"), true, "source file in code span");
});

// 3. Empty history renders an honest note instead of a bare transcript.
check("empty history exports an honest message", () => {
  const mdText = E.renderMarkdown([], { now: fixedNow });
  eq(mdText.includes("session history was empty"), true, "empty note");
  eq(mdText.includes("0 message"), true, "zero count");
});

// 4. memory flag renders the recall badge context.
check("memory badge history entries survive export", () => {
  const mdText = E.renderMarkdown([{ role: "nova", text: "recalled", memory: true }], { now: fixedNow });
  eq(mdText.includes("recalled"), true, "text preserved");
});

// 5. Suggested filename format.
check("filename is nova-session-YYYY-MM-DD.md", () => {
  eq(E.suggestFilename(fixedNow), "nova-session-2026-08-18.md", "filename");
});

// 6. Download plumbing: Blob + anchor click + cleanup.
check("downloadMarkdown creates a blob, clicks an anchor, returns the filename", () => {
  const mdText = E.renderMarkdown(sample, { now: fixedNow });
  const name = E.downloadMarkdown(mdText, "custom-name.md");
  eq(name, "custom-name.md", "returned filename");
  eq(createdAnchor.download, "custom-name.md", "anchor download attr");
  eq(createdAnchor._clicked, true, "anchor clicked");
  eq(!!createdAnchor._appended, true, "anchor appended to body");
  // Blob content carries the markdown.
  const blob = createdAnchor.href ? global.URL._urls[createdAnchor.href] : null;
  eq(blob instanceof global.Blob, true, "blob created");
  eq(blob.parts[0], mdText, "blob content");
  eq(blob.type.includes("markdown"), true, "mime type");
});

// 7. Default filename when none supplied.
check("download uses the suggested filename by default", () => {
  createdAnchor = null;
  E.downloadMarkdown("x", null);
  eq(createdAnchor.download, E.suggestFilename(), "default filename used");
});

// 8. saveAsNote calls notes:add-note with the transcript and returns ok.
check("saveAsNote routes through notes:add-note", async () => {
  global.window.nova = {
    runAction: async (id, payload, opts) => {
      eq(id, "notes:add-note", "action id");
      eq(payload.text.startsWith("Session transcript "), true, "title prefix");
      eq(payload.text.includes("# Nova session transcript"), true, "transcript included");
      eq(opts.dryRun, false, "not a dry run");
      return { outcome: "success", detail: { note: { id: "n1" } } };
    },
  };
  const res = await E.saveAsNote(sample, { appName: "Nova" });
  eq(res.ok, true, "save ok");
  eq(res.detail.note.id, "n1", "note detail returned");
});

// 9. saveAsNote handles a failed action gracefully.
check("saveAsNote surfaces action failure", async () => {
  global.window.nova = {
    runAction: async () => ({ outcome: "failed", detail: { error: "store full" } }),
  };
  const res = await E.saveAsNote(sample);
  eq(res.ok, false, "save failed flagged");
  eq(res.detail.error, "store full", "error passed through");
});

// 10. saveAsNote tolerates a thrown IPC error.
check("saveAsNote tolerates thrown errors", async () => {
  global.window.nova = {
    runAction: async () => { throw new Error("bridge dead"); },
  };
  const res = await E.saveAsNote(sample);
  eq(res.ok, false, "throw flagged as failed");
  eq(String(res.detail.error).includes("bridge dead"), true, "error message kept");
});

// 11. User-src marker shows the input source.
check("user messages show their source channel", () => {
  const mdText = E.renderMarkdown([{ role: "user", text: "hi", src: "typed" }], { now: fixedNow });
  eq(mdText.includes("via typed"), true, "source shown");
});

console.log(`\n${passed} history-export test(s) passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

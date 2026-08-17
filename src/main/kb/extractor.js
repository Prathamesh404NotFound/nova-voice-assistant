// Text extraction for the knowledge base (Stage 8).
// Supports .txt / .md (direct read), .pdf (pdf-parse), .docx (mammoth).
// Extraction never sends content anywhere. Errors are recorded, not thrown.

const fs = require("fs");
const path = require("path");

const SUPPORTED = new Set([".txt", ".md", ".pdf", ".docx"]);

function isSupportedFile(filePath) {
  return SUPPORTED.has(path.extname(filePath).toLowerCase());
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — skip bigger files

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!isSupportedFile(filePath)) {
    return { text: null, skipped: true, reason: `unsupported type (${ext || "none"})` };
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { text: null, skipped: true, reason: `stat failed: ${err.message}` };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { text: null, skipped: true, reason: `file too large (${stat.size} bytes)` };
  }
  try {
    let text;
    if (ext === ".txt" || ext === ".md") {
      text = fs.readFileSync(filePath, "utf8");
    } else if (ext === ".pdf") {
      const data = fs.readFileSync(filePath);
      const pdf = require("pdf-parse");
      const info = await pdf(data);
      text = info?.text || "";
    } else if (ext === ".docx") {
      const mammoth = require("mammoth");
      const res = await mammoth.extractRawText({ path: filePath });
      text = res?.value || "";
    }
    if (typeof text !== "string") {
      return { text: null, skipped: true, reason: "extraction returned non-string" };
    }
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length < 5) {
      return { text: null, skipped: true, reason: "too little text" };
    }
    return { text: trimmed, skipped: false };
  } catch (err) {
    return { text: null, skipped: true, reason: String(err?.message || err) };
  }
}

module.exports = { extractText, isSupportedFile, SUPPORTED };

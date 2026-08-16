# Stage 6 — Voice-Driven File Management

**Nova · 2026-08-17**

All file operations plug into the existing permission framework (`gate.js`, `action-log.js`, `undo.js`, `action-registry.js`). No file action ever bypasses the gate: reads are L0 (immediate, logged), moves/renames/copies are L2 (toast), deletes are L4 (modal, never permanent — always the OS Recycle Bin/Trash).

## Architecture

```
agent/classifier.js (+ "files" intent)
        │
        ▼
agent/dispatcher.js ── files branch
        │
        ▼
main/files/toolbox.js     fs-toolbox: search, hash, stats, organize-plan, trash
main/files/actions.js     register all `files:*` actions (L0/L2/L3/L4) w/ simulate + reverse
        │
        ▼
permissions/gate.js       existing gate (toast L2 / modal L3–4 / dry-run / log)
```

## File actions registered (`main/files/actions.js`)

| Action | Level | Gate | Notes |
|--------|-------|------|-------|
| `files:search` | L0 | immediate | filename / extension / mtime across Documents/Downloads/Desktop (default) or "everywhere" (home + drives) |
| `files:detect-duplicates` | L0 | immediate | SHA-256 content hash within a named folder; reports groups |
| `files:folder-stats` | L0 | immediate | size of a folder; powers "how much space is Downloads taking up" |
| `files:organize` | L2 | toast after dry-run | dry-run via `simulate()` MANDATORY first (proposed structure + counts); never deletes |
| `files:move-files` | L2 | toast | rename/move/copy with `reverse` fn → Nova Undo works |
| `files:copy-files` | L2 | toast | copy with reverse (delete copy) |
| `files:rename-file` | L2 | toast | reverse fn renames back |
| `files:remove-duplicates` | L2 | toast after dry-run | only files the detection step already listed; keeps one copy (newest) |
| `files:delete-files` | L4 | modal, never bypassed | only files explicitly named/confirmed from a dry-run list; goes to OS trash (moveToTrash or recycle-bin path), never permanent |

## Key design decisions

1. **Organize always dry-runs first.** `organize` execution requires `opts.dryRun === true` on the first pass (renderer flow: dispatcher emits the dry-run report as a preview card → user confirms → dispatcher re-runs with dryRun:false). The execute() body refuses a non-dry-run call whose payload was never dry-run'd (payload carries `previewToken` from the dry-run report). Category map: Documents (pdf/doc/docx/txt/odt), Images (jpg/png/gif/svg/webp), Videos, Audio (mp3/wav/m4a), Archives (zip/rar/7z/tar.gz), Installers (exe/msi/dmg/app/iso), Other.
2. **Duplicates:** detect = L0 (read-only, hash groups). Remove = L2 with dry-run preview (which files would be removed, which kept). Keep the newest file in each group; only listed files are eligible for removal.
3. **Delete = L4 only.** Parser refuses bare `delete junk files`-style commands: the file planner requires explicit target names or a confirmed dry-run list. Execute moves files to the OS trash: on Windows via PowerShell's recycle bin (`Add-Type` Win32 `SHFileOperation` fallback: use `shell:recyclebinfolder` COM is heavy — instead use `cmd /c "del /f"` is permanent… so implement via a small native-path: on win32 use PowerShell `Move-Item` into `$Recycle.Bin` requires CLSID; simplest reliable cross-version approach: `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(path, 'OnlyErrorDialogs','SendToRecycleBin')"`). macOS: `osascript` `tell app "Finder" to delete (POSIX file ...)` (works, moves to Trash). Linux: try `gio trash`; fall back to `trash-put` → error out with plain message.
4. **Undo + OS trash are complementary:** L2 file actions get Nova's own `reverse` fn (5-minute window); L4 deletes rely on OS Recycle Bin so the user can restore outside Nova too. L4 actions have NO Nova undo (never register in the tracker — consistent with the L3+ rule).
5. **Search scope control:** default folders + "search everywhere" widens to `os.homedir()` (still skips hidden + node_modules + .git to keep L0 safe and fast).
6. **Private Mode:** L0 reads are allowed (local-only, like OCR); L2 toast actions blocked like control's physical flag? Spec says every action goes through the gate — gate already blocks L3+ in private mode; file L2 reads/moves stay allowed in Private Mode (they are local, no network). Matches control's "physical" flag distinction.
7. **Voice trigger phrases** (added to classifier FILE_RE): find/search/locate, duplicates, clean up/organize/tidy, rename this/move this/move these, how much space, delete/remove this file (delete ALWAYS requires the L4 confirm modal — phrases trigger a named-target parse only).

## Dry-run flow (renderer)

1. User says "clean up my Downloads folder".
2. Dispatcher plans → runs `files:organize` with `{ dryRun: true }` → preview card rendered ("Documents/ (12 files) · Images/ (23 files) · Installers/ (4 files)" + Confirm/Cancel).
3. Confirm → re-run with `previewToken` → L2 toast (5 s cancel) → moves begin → checklist updates.
4. Reject at either gate → log entry `cancelled`/`dry-run`, no file touched.

## Tests (new `src/main/test-files.js`, headless, tmpdir-based)

- ~40 checks: search by name/ext/mtime + everywhere scope; duplicate hash detection (same content, different names); folder stats; organize dry-run preview shape + execute with token + refusal without token + never deletes (originals intact, categories); move/rename/copy with reverse + undo end-to-end; duplicate removal (kept-newest, dry-run); L4 delete to recycle bin (real trash on linux via gio/real test in tmpdir — uses `files:trash-test` only under `TEST_NO_PERMANENT_DELETE=true` guard, else mocked trash fn injected via `setTrashForTesting()`); parser refusal of bare delete; dry-run rejected flow (cancelled log entry); action log entries + taskId flow.

## Demo commands

- "find my resume"
- "how much space is Downloads taking up"
- "find duplicates in Downloads" then "remove the duplicates"
- "clean up my Downloads folder" (dry-run → confirm)
- "rename this file to X" / "move these to Documents" (target resolved from last search context — "this file" = last search result #1 in dispatcher's file context)
- delete only after an explicit preview confirm

# Changelog

## 1.2.0 — 2026-09-28

Chat reliability and a rebuilt Explorer.

### Chat: sending a prompt and waiting for the reply

- **Accurate live status.** A status strip above the input shows what is actually happening: *Connecting → Waiting for the first words → Thinking → Writing the reply → Reading files → Writing files*, with elapsed time, output tokens, and the turn number. It stays visible wherever the transcript is scrolled. It replaces the old progress ring and "SYNCHRONIZING" readout, which were estimates.
- **No more false "STALLED".** Thinking/reasoning tokens (Claude extended thinking, DeepSeek reasoner, Ollama `think`) and server keep-alive pings now count as activity. Before, a model that was thinking looked silent: the task was marked stalled and sometimes cancelled mid-answer.
- **Honest stall warning.** When nothing arrives for a while, the strip turns amber and says how long it has been silent and when the request will be given up.
- **Errors are shown, not swallowed.** Several failures used to leave a blank or cut-off reply with no explanation. Each now shows a clear message:
  - errors in the middle of a stream (e.g. `overloaded_error`)
  - Ollama HTTP errors
  - empty replies
  - "thought but never answered"
  - replies cut off by the output-token limit
- **Failed turns no longer break the chat.** Error lines, stop notices, file-write summaries and the welcome text are UI-only and are never sent back to the model. Empty assistant turns are dropped. Before, one failed request could make every later request in that chat fail too.
- **Retry / Resume** re-runs the task from your last message.
- **Per-chat tasks.** Each chat has its own running task and status. Switching chats mid-reply no longer mixes them up, and a second send can't start while one is running.
- **Send / Stop button** in the compose box. ⌘C only stops a task when no text is selected, so you can copy from a reply while it streams.
- **Smoother streaming.** The transcript updates once per frame. Chat history is saved at most every 0.8 s instead of being rewritten to disk on every token, and saves are serialized per project.
- The fixed overall task timeout is gone. It could kill long, still-streaming answers. Hung requests are caught by the no-activity watcher instead.
- File/image blocks are applied from every turn of a task, and file-read round trips keep the earlier files in context.

### Explorer

- **New Folder**, alongside New File. Both are available from the header, from the buttons on each folder row, and from the right-click menu.
  - Nested names like `src/lib/a.ts` create the folders in between.
  - Existing files are never overwritten, and invalid names are rejected inline.
- **Rename** (F2) and **Move to Trash** (⌘⌫ / Delete). Deleting goes through the OS Trash, so it can be undone.
- **Drag and drop to move** files and folders with the mouse:
  - The destination folder is highlighted.
  - Collapsed folders open when you hover over them.
  - The tree scrolls when you drag near its edge.
  - Esc cancels the drag, and a folder can't be moved into itself.
- **Drop files from Finder** onto a folder to copy them in. Name clashes become "name copy.ext".
- Open tabs follow a renamed or moved file. Tabs of trashed files close.
- **Keyboard navigation:** ↑/↓, ←/→ to collapse/expand, and Enter to open.
- Expanded folders are remembered per project and refresh in place when files change (including files the agent writes into nested folders).

### Other

- The HTML preview only renders while the preview pane is shown.
- Starting and stopping the integrated terminal is more robust (no orphaned PTY sessions, and errors are shown).
- `npm test` runs the unit tests in `tests/`.
- New Rust command `move_to_trash` (via the `trash` crate), plus fs `rename` / `copy-file` permissions.

---

### สรุปภาษาไทย

- **แชท:** แถบสถานะบอกขั้นตอนตามจริง ได้แก่ เชื่อมต่อ, รอคำตอบ, กำลังคิด, กำลังเขียน, อ่านไฟล์ และเขียนไฟล์ พร้อมเวลาและจำนวนโทเคน
  - ไม่ขึ้น "ค้าง" ผิดๆ ตอนโมเดลกำลังคิดอีกแล้ว
  - ถ้าเกิด error จะบอกสาเหตุชัดเจน
  - ข้อความ error จะไม่ถูกส่งกลับไปให้โมเดล แชทจึงไม่เสียต่อเนื่อง
  - สถานะแยกตามแชท และมีปุ่มส่ง/หยุด
- **Explorer:** สร้างโฟลเดอร์ได้ เปลี่ยนชื่อได้ ลบแล้วไฟล์ไปอยู่ในถังขยะ (กู้คืนได้)
  - ลากย้ายไฟล์ด้วยเมาส์ได้จริง
  - ลากไฟล์จาก Finder มาวางได้
  - ใช้คีย์บอร์ดเลื่อนเลือกไฟล์ได้

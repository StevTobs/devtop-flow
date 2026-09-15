# DevTop Flow

A standalone macOS IDE with built-in support for Claude, ChatGPT, DeepSeek (cloud, primary) and local models via Ollama (optional). Built with **Tauri + React + Monaco Editor** — this is a native `.app`, not a VS Code extension.

## What's working

```
devtop-flow/
├── src/                          # React frontend
│   ├── App.tsx                    # Shell: wires filesystem, keys, models, chat together
│   ├── components/
│   │   ├── Sidebar.tsx             # Real file explorer (lazy-loaded dirs) + model list
│   │   ├── EditorPane.tsx          # Monaco editor, branded theme, selection tracking
│   │   ├── ChatPanel.tsx           # Model picker, streaming chat, context chip
│   │   └── Settings.tsx            # API key entry (Keychain-backed)
│   ├── lib/
│   │   ├── modelProvider.ts         # ⭐ Core abstraction layer — Claude / OpenAI-compatible / Ollama adapters
│   │   ├── secrets.ts               # Wraps the Rust save/get/delete_api_key commands
│   │   ├── fileSystem.ts            # Folder picker, lazy directory listing, text + binary read/write
│   │   ├── imageGen.ts              # SVG→PNG/JPG rasterizer + generative image model (gpt-image-1)
│   │   └── contextBuilder.ts        # Builds the "attached file/selection" system message
│   └── styles.css                  # Brand palette as CSS variables
├── src-tauri/                    # Rust native shell
│   ├── src/main.rs                 # Window setup + Keychain-backed API key commands + fs/dialog plugins
│   ├── capabilities/default.json    # Tauri v2 permissions (fs, dialog, shell)
│   ├── tauri.conf.json              # App identity, window config, CSP, bundle targets (.dmg/.app)
│   └── icons/                       # Generated from devtop-flow-app-icon.png, incl. icon.icns
├── package.json
└── vite.config.ts
```

- **Real file I/O** — Open Folder (native picker) → lazy-loaded file tree → click to open in Monaco → Cmd+S to save.
- **Model abstraction layer** — one `ModelProvider` interface, adapters for Anthropic (SSE), OpenAI-compatible (shared by ChatGPT & DeepSeek), and Ollama (NDJSON, auto-detected on `localhost:11434` at startup).
- **Settings (⚙ in the sidebar)** — paste an API key → stored in the macOS Keychain via `save_api_key`/`get_api_key`/`delete_api_key` Tauri commands, never in plaintext config.
- **Chat panel** — model picker (built from whichever providers have a key set, plus any detected local Ollama models), streaming responses, "📎 Attach" to send the active file or current selection as context, rough token-count indicator.
- **Image creation** — the agent can write real `.png`/`.jpg` files into the open project, two ways. A ` ```devtopflow:draw ` block has it write SVG that the app rasterizes locally (free, offline, exact — works with Claude, DeepSeek and local Ollama models, none of which have an image endpoint); a ` ```devtopflow:image ` block calls OpenAI's `gpt-image-1` for photographic/illustrative output (needs the OpenAI key, billed per image against the same budget monitor as chat). Both are confined to the open folder and must target `.png`/`.jpg`; the result opens straight into a preview tab. Creating a `.png`/`.jpg` from the Explorer's new-file button writes a real blank canvas rather than an unopenable zero-byte file.

Still open (see the build plan's §10 order): multi-file diff apply/reject UI, the "generate app from prompt" flow, integrated terminal, git integration, and eventual code signing/notarization for distribution outside this machine.

## Run it

```bash
cd devtop-flow
npm install
npm run tauri dev
```

Opens a native macOS window with hot reload. First run compiles the Rust side (~1 min); after that, `cargo`'s cache makes it fast.

## Build the distributable `.dmg`

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/dmg/`. Unsigned — Gatekeeper will warn other users on first launch. For real distribution, see the build plan's "macOS Packaging & Distribution" section (Developer ID cert, `notarytool`).

# Does the Desktop app update automatically when I edit code?

**No.** The `DevTop Flow.app` icon on the Desktop is a compiled snapshot. Editing source files in the IDE won't change it automatically.

There are two different modes:

## Dev mode — live editing

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd "/Users/topbook/Desktop/VS-CODE-Repo/DevTop Flow/devtop-flow"
npm run tauri dev
```

Opens a live window that **hot-reloads** as you edit `.tsx`/`.css` files. Good for active development, but it's not the Desktop icon — it's a separate window launched from Terminal, and it closes when you stop the command.

## The Desktop `.app` — a frozen build

To make it reflect your edits, rebuild and refresh it:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd "/Users/topbook/Desktop/VS-CODE-Repo/DevTop Flow/devtop-flow"
npm run tauri build
```

Then copy the new build over the old one:

```bash
rm -rf "/Users/topbook/Desktop/DevTop Flow.app"
cp -R "src-tauri/target/release/bundle/macos/DevTop Flow.app" "/Users/topbook/Desktop/"
xattr -dr com.apple.quarantine "/Users/topbook/Desktop/DevTop Flow.app"
```

## Rule of thumb

- **Actively making changes right now?** Use dev mode — you'll see edits live.
- **Done editing, want the Desktop icon current?** Rebuild and copy over, as above.

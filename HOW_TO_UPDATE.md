# Does the installed app update automatically when I edit code?

**No.** `DevTop Flow.app` (in `/Applications`, and the copy on the Desktop) is a compiled snapshot. Editing source files won't change it automatically.

There are two different modes:

## Dev mode — live editing

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/Documents/GitHub/devtop-flow
npm run tauri dev
```

This opens a live window that **hot-reloads** as you edit `.tsx`/`.css` files. Good for active development. It is a separate window launched from Terminal, and it closes when you stop the command.

## The installed `.app` — a frozen build

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` (also the window `title`), and `src-tauri/Cargo.toml`, then add an entry to `CHANGELOG.md`.
2. Build:

   ```bash
   export PATH="$HOME/.cargo/bin:$PATH"
   cd ~/Documents/GitHub/devtop-flow
   npm test
   npm run tauri build -- --bundles app
   ```

3. If signing fails with *"resource fork, Finder information, or similar detritus not allowed"*, strip the extended attributes and sign by hand. This happens because the repo lives in the synced `~/Documents`.

   ```bash
   APP="src-tauri/target/release/bundle/macos/DevTop Flow.app"
   xattr -cr "$APP"
   codesign --force --deep --sign "DevTop Flow Local Dev" "$APP"
   ```

4. Replace the installed copies. Quit the app first.

   ```bash
   osascript -e 'quit app "DevTop Flow"'
   for dest in "/Applications" "$HOME/Desktop"; do
     rm -rf "$dest/DevTop Flow.app"
     ditto "src-tauri/target/release/bundle/macos/DevTop Flow.app" "$dest/DevTop Flow.app"
   done
   ```

Keep signing with the same "DevTop Flow Local Dev" certificate. The Keychain ties saved API keys to the app's signature, so signing differently makes macOS ask for access to them again.

## Rule of thumb

- **Actively making changes right now?** Use dev mode — you'll see edits live.
- **Done editing, want the installed app current?** Rebuild and copy over, as above.

# Building DevTop Flow for macOS (one universal `.dmg`)

The output is a **single `.dmg` that runs on both Apple Silicon and Intel Macs**
(a universal binary). A `.dmg` can only be built *on macOS* — Tauri's bundler
needs Apple's `hdiutil`/`codesign` and the macOS SDK — so there are two routes.

## Route A — from Windows, via GitHub Actions (no Mac needed)

`.github/workflows/build-macos.yml` builds it on a GitHub-hosted Mac.

1. Create a **private** repository on github.com (it's free).
2. Push this folder to it:
   ```powershell
   git init -b main
   git add .
   git commit -m "DevTop Flow source"
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. The push starts the build automatically (or: **Actions** tab → *Build macOS .dmg* → **Run workflow**). First run takes ~15 min; later runs are faster thanks to the Rust cache.
4. Open the finished run → **Artifacts** → download **DevTop-Flow-macOS-dmg**. GitHub wraps it in a `.zip`; the `.dmg` is inside.

## Route B — on a Mac

Prerequisites: Node.js LTS, Rust (`rustup`), Xcode Command Line Tools (`xcode-select --install`).

```bash
./build-mac.sh
```

Output: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/DevTop Flow_0.1.0_universal.dmg`

On the original dev Mac it keeps signing with the local *DevTop Flow Local Dev*
certificate (so saved API keys stay accessible without Keychain re-prompts);
anywhere else it falls back to ad-hoc signing.

## First launch on another Mac

The app isn't notarized (that needs a paid Apple Developer ID), so Gatekeeper
blocks the first launch — "can't be opened" or "is damaged". After dragging it
to Applications, run once:

```bash
xattr -dr com.apple.quarantine "/Applications/DevTop Flow.app"
```

or right-click the app → **Open** → **Open**. Only needed once per install.

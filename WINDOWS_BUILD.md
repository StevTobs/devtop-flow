# Building DevTop Flow for Windows

The source is already portable — cross-platform config (Keychain vs. Credential
Manager for API keys, `.ico` icon, portable bundle targets) is done and
verified against the macOS build. Producing the actual `.exe` has to happen
on a real Windows machine — it can't be cross-compiled from this Mac.

## 1. Install prerequisites (one-time)

- **[Node.js LTS](https://nodejs.org)**
- **[Rust via rustup](https://rustup.rs)** — accept the default (MSVC) toolchain when prompted
- **Visual Studio Build Tools** — required by Tauri on Windows.
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools
  ```
  In the installer, select the **"Desktop development with C++"** workload.
- **WebView2 Runtime** — already built into Windows 10/11 on virtually all modern machines; nothing to do.

## 2. Get the project onto that machine

This project isn't in a git repo, so the simplest way is to zip the whole
`devtop-flow` folder and transfer it via cloud drive / USB / etc. (Set up git
first if you'd rather sync it that way instead.)

## 3. Build it

```powershell
cd devtop-flow
npm install
npm run tauri build
```

## 4. Find the output

```
src-tauri\target\release\bundle\nsis\DevTop Flow_0.1.0_x64-setup.exe
```

That's the single shareable installer `.exe`. An `.msi` is also built
alongside it in `bundle\msi\` if you'd rather distribute that format instead.

## Expect a SmartScreen warning

Since the installer is unsigned (no Windows code-signing certificate), Windows
SmartScreen will show a "Windows protected your PC" warning on first run —
normal for unsigned installers, not a bug. A paid code-signing certificate is
the fix if this needs to go away later.

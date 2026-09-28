# Building DevTop Flow for Windows

A Windows build needs the MSVC toolchain, so the `.exe` can't be built on a
Mac. There are two ways to get one.

## Option A — GitHub Actions (no Windows machine needed)

`.github/workflows/build-windows.yml` builds the installer on a GitHub-hosted
Windows runner on every push to `main`. You can also run it by hand from
**Actions → "Build Windows .exe" → Run workflow**.

When the run finishes, download the **DevTop-Flow-Windows-exe** artifact from
the run's page, or from the command line:

```bash
gh run download --name DevTop-Flow-Windows-exe --dir ./windows-build
```

## Option B — build on a Windows machine

1. Install the prerequisites (one-time):
   - **[Node.js LTS](https://nodejs.org)**
   - **[Rust via rustup](https://rustup.rs)**. Accept the default (MSVC) toolchain.
   - **Visual Studio Build Tools**, with the **"Desktop development with C++"** workload:
     ```powershell
     winget install Microsoft.VisualStudio.2022.BuildTools
     ```
   - **WebView2 Runtime**. It's already built into Windows 10/11.
2. Build:
   ```powershell
   git clone git@github.com:StevTobs/devtop-flow.git
   cd devtop-flow
   npm ci
   npm run tauri build -- --bundles nsis,msi
   ```

## Output

```
src-tauri\target\release\bundle\nsis\DevTop Flow_<version>_x64-setup.exe   ← the installer to share
src-tauri\target\release\bundle\msi\DevTop Flow_<version>_x64_en-US.msi   ← same app, .msi format
```

The installer installs per-user (`installMode: currentUser`), so it doesn't
need admin rights.

## Expect a SmartScreen warning

The installer is unsigned (there's no Windows code-signing certificate), so on
first run Windows SmartScreen shows "Windows protected your PC". Click
**More info → Run anyway**. This is normal for unsigned installers, not a bug.
A paid code-signing certificate would remove the warning.

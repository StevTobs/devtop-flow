import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  /** Only read once, at the first mount — the terminal doesn't follow the project folder if it changes afterward. */
  projectRoot?: string;
  visible: boolean;
}

/**
 * Integrated terminal (VS Code-style, hideable). A real PTY via the Rust
 * side's `portable-pty` — not just a spawned process with captured stdout —
 * so interactive programs, color, cursor movement, and `cd` all work.
 * Always mounted (just display:none'd when hidden) so the shell session
 * stays alive across show/hide toggles, matching VS Code's behavior.
 */
export default function TerminalPanel({ projectRoot, visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>();
  const fitRef = useRef<FitAddon>();
  const sessionIdRef = useRef<number>();

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      convertEol: true,
      fontFamily: "SF Mono, JetBrains Mono, ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#0c0c0c", foreground: "#f2e6df", cursor: "#f2e6df" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let unlistenOutput: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;
    let cancelled = false;

    invoke<number>("terminal_start", { cwd: projectRoot ?? "" }).then(async (id) => {
      if (cancelled) {
        invoke("terminal_kill", { id });
        return;
      }
      sessionIdRef.current = id;
      unlistenOutput = await listen<string>(`terminal-output-${id}`, (e) => term.write(e.payload));
      unlistenClosed = await listen(`terminal-closed-${id}`, () => term.write("\r\n[process exited]\r\n"));
      invoke("terminal_resize", { id, cols: term.cols, rows: term.rows });
    });

    const dataDisposable = term.onData((data) => {
      if (sessionIdRef.current !== undefined) invoke("terminal_write", { id: sessionIdRef.current, data });
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (sessionIdRef.current !== undefined) {
        invoke("terminal_resize", { id: sessionIdRef.current, cols: term.cols, rows: term.rows });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenOutput?.();
      unlistenClosed?.();
      if (sessionIdRef.current !== undefined) invoke("terminal_kill", { id: sessionIdRef.current });
      term.dispose();
    };
    // Deliberately mount-once: the PTY session and xterm instance both need
    // to survive show/hide toggles, not restart on every projectRoot change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The container has zero size while hidden (display:none), so xterm's
  // internal character-cell measurements go stale — re-fit once it's shown again.
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && sessionIdRef.current !== undefined) {
        invoke("terminal_resize", { id: sessionIdRef.current, cols: term.cols, rows: term.rows });
      }
    });
  }, [visible]);

  return (
    <div className="terminal-panel" style={{ display: visible ? "flex" : "none" }}>
      <div className="terminal-panel-inner" ref={containerRef} />
    </div>
  );
}

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

    let sessionId: number | undefined;
    const killSession = () => {
      if (sessionId === undefined) return;
      const id = sessionId;
      sessionId = undefined;
      if (sessionIdRef.current === id) sessionIdRef.current = undefined;
      void invoke("terminal_kill", { id }).catch(console.error);
    };
    const start = async () => {
      try {
        const id = await invoke<number>("terminal_start", { cwd: projectRoot ?? "" });
        sessionId = id;
        if (cancelled) { killSession(); return; }
        const output = await listen<string>(`terminal-output-${id}`, (e) => {
          if (!cancelled) term.write(e.payload);
        });
        if (cancelled) { output(); killSession(); return; }
        unlistenOutput = output;
        const closed = await listen(`terminal-closed-${id}`, () => {
          if (!cancelled) term.write("\r\n[process exited]\r\n");
          killSession();
        });
        if (cancelled) { closed(); killSession(); return; }
        unlistenClosed = closed;
        if (sessionId === undefined) return;
        sessionIdRef.current = id;
        await invoke("terminal_resize", { id, cols: term.cols, rows: term.rows });
      } catch (error) {
        unlistenOutput?.();
        unlistenClosed?.();
        killSession();
        if (!cancelled) term.write(`\r\n[Terminal failed: ${String(error)}]\r\n`);
      }
    };
    void start();

    const dataDisposable = term.onData((data) => {
      if (sessionIdRef.current !== undefined) void invoke("terminal_write", { id: sessionIdRef.current, data }).catch(console.error);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current?.clientWidth || !containerRef.current?.clientHeight) return;
      fit.fit();
      if (sessionIdRef.current !== undefined) {
        void invoke("terminal_resize", { id: sessionIdRef.current, cols: term.cols, rows: term.rows }).catch(console.error);
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenOutput?.();
      unlistenClosed?.();
      killSession();
      if (termRef.current === term) {
        termRef.current = undefined;
        fitRef.current = undefined;
      }
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
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && sessionIdRef.current !== undefined) {
        void invoke("terminal_resize", { id: sessionIdRef.current, cols: term.cols, rows: term.rows }).catch(console.error);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div className="terminal-panel" style={{ display: visible ? "flex" : "none" }}>
      <div className="terminal-panel-inner" ref={containerRef} />
    </div>
  );
}

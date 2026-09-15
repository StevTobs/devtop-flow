import { useEffect, useMemo, useState } from "react";
import Editor, { loader, OnMount } from "@monaco-editor/react";
import { svgTextToDataUrl } from "../lib/fileSystem";
import { buildHtmlPreviewDoc } from "../lib/htmlPreview";

// @monaco-editor/react defaults to loading Monaco's AMD bundle from
// cdn.jsdelivr.net via an injected <script> tag — blocked outright by the
// packaged app's CSP (script-src 'self'), which left the editor stuck on
// "Loading…" forever with no error (the CDN request just never happens).
// Invisible in `tauri dev`, which isn't served under that CSP.
//
// Bundling monaco-editor's ESM source through Vite (the usual `?worker`
// import approach) hits a Rolldown resolution failure specific to this
// project's bundler (rolldown-vite) on the base editor worker, while the
// language workers resolve fine — a bundler-level edge case, not something
// fixable from app code. Self-hosting the prebuilt AMD bundle instead
// (copied verbatim into public/monaco-vs, so Vite serves it unprocessed)
// sidesteps that entirely: same mechanism as the default CDN config, just
// pointed at a same-origin path the CSP already allows, worker creation and
// all — no manual worker wiring needed.
loader.config({ paths: { vs: "/monaco-vs" } });

export interface EditorTab {
  path: string;
  relativePath: string;
  dirty: boolean;
}

interface EditorPaneProps {
  tabs: EditorTab[];
  activeTabPath?: string;
  language: string;
  value: string;
  /** Set for raster images (jpg/png/gif/…) — a view-only image tab, no Monaco. */
  imageSrc?: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChange: (value: string | undefined) => void;
  onSelectionChange?: (selectedText: string) => void;
}

// DevTop Flow custom Monaco theme, tuned to the brand palette
const defineBrandTheme = (monaco: any) => {
  monaco.editor.defineTheme("devtop-flow-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6e6f3b", fontStyle: "italic" },
      { token: "keyword", foreground: "8954c4" },
      { token: "string", foreground: "9dab37" },
      { token: "number", foreground: "bc64c8" },
    ],
    colors: {
      "editor.background": "#14121c",
      "editor.foreground": "#f2e6df",
      "editorCursor.foreground": "#8954c4",
      "editor.lineHighlightBackground": "#1b1826",
      "editorLineNumber.foreground": "#4a4658",
      "editor.selectionBackground": "#401c7566",
    },
  });
};

export default function EditorPane({
  tabs,
  activeTabPath,
  language,
  value,
  imageSrc,
  onSelectTab,
  onCloseTab,
  onChange,
  onSelectionChange,
}: EditorPaneProps) {
  const [showPreview, setShowPreview] = useState(true);
  const [codeHidden, setCodeHidden] = useState(false);
  const [tabsHidden, setTabsHidden] = useState(false);

  const handleMount: OnMount = (editor) => {
    editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      const text = selection && model ? model.getValueInRange(selection) : "";
      onSelectionChange?.(text);
    });
  };

  const isHtml = language === "html";
  const isSvg = (activeTabPath ?? "").toLowerCase().endsWith(".svg");
  const previewable = isHtml || isSvg;

  // Resolving and inlining the HTML's linked .css/.js/image files means real
  // disk reads, so this can't stay a synchronous useMemo like the SVG preview
  // below — it's debounced so a fast typist doesn't trigger a filesystem pass
  // per keystroke, and `cancelled` guards against an in-flight build from a
  // now-stale value/tab clobbering a newer one that resolved first.
  const [htmlPreviewDoc, setHtmlPreviewDoc] = useState<string>();
  useEffect(() => {
    if (!isHtml || !activeTabPath) {
      setHtmlPreviewDoc(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      buildHtmlPreviewDoc(value, activeTabPath).then((doc) => {
        if (!cancelled) setHtmlPreviewDoc(doc);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isHtml, activeTabPath, value]);

  const previewSrc = useMemo(() => {
    if (isHtml) return htmlPreviewDoc ? { kind: "html" as const, doc: htmlPreviewDoc } : undefined;
    if (isSvg) return { kind: "svg" as const, url: svgTextToDataUrl(value) };
    return undefined;
  }, [isHtml, isSvg, value, htmlPreviewDoc]);

  if (tabs.length === 0) {
    return (
      <div className="tabs-empty">
        <div className="empty-hint" style={{ margin: "auto", cursor: "default" }}>
          Open a file from the Explorer to start editing.
        </div>
      </div>
    );
  }

  const tabBar = (
    <div className="tabs-row">
      {tabsHidden ? (
        <div className="tabs-hidden-hint">
          {tabs.find((t) => t.path === activeTabPath)?.relativePath}
          {tabs.find((t) => t.path === activeTabPath)?.dirty && (
            <span className="tab-dirty" title="Unsaved changes">
              {" "}
              *
            </span>
          )}
        </div>
      ) : (
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={`tab ${t.path === activeTabPath ? "active" : ""}`}
              onClick={() => onSelectTab(t.path)}
              title={t.relativePath}
            >
              <span className="tab-label">{t.relativePath}</span>
              {t.dirty && (
                <span className="tab-dirty" title="Unsaved changes">
                  *
                </span>
              )}
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(t.path);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="tabs-row-actions">
        {previewable && (
          <>
            <button className="text-btn" onClick={() => setShowPreview((v) => !v)} title="Toggle preview">
              {showPreview ? "🖥 Hide preview" : "🖥 Preview"}
            </button>
            {showPreview && (
              <button className="text-btn" onClick={() => setCodeHidden((v) => !v)} title="Expand preview, hiding the code">
                {codeHidden ? "⛶ Show code" : "⛶ Expand preview"}
              </button>
            )}
          </>
        )}
        <button
          className="text-btn"
          onClick={() => setTabsHidden((v) => !v)}
          title={tabsHidden ? "Show tabs" : "Hide tabs"}
        >
          {tabsHidden ? "▾ Tabs" : "▴ Hide tabs"}
        </button>
      </div>
    </div>
  );

  if (imageSrc) {
    return (
      <div className="editor-pane">
        {tabBar}
        <div className="image-viewer">
          <img src={imageSrc} alt={tabs.find((t) => t.path === activeTabPath)?.relativePath ?? ""} />
        </div>
      </div>
    );
  }

  return (
    <div className="editor-pane">
      {tabBar}
      <div className="editor-body">
        {!(previewable && showPreview && codeHidden) && (
          <div className="monaco-wrapper">
            <Editor
              height="calc(100vh - 44px - 36px - 22px)"
              theme="devtop-flow-dark"
              language={language}
              value={value}
              onChange={onChange}
              onMount={handleMount}
              beforeMount={defineBrandTheme}
              options={{
                fontFamily: "SF Mono, JetBrains Mono, monospace",
                fontSize: 13,
                minimap: { enabled: true },
                smoothScrolling: true,
                cursorBlinking: "smooth",
              }}
            />
          </div>
        )}
        {previewable && showPreview && previewSrc?.kind === "html" && (
          <iframe
            title="HTML Preview"
            srcDoc={previewSrc.doc}
            sandbox="allow-scripts"
            className={`html-preview ${codeHidden ? "html-preview-full" : ""}`}
          />
        )}
        {previewable && showPreview && previewSrc?.kind === "svg" && (
          <div className={`svg-preview ${codeHidden ? "html-preview-full" : ""}`}>
            <img src={previewSrc.url} alt="SVG preview" />
          </div>
        )}
      </div>
    </div>
  );
}

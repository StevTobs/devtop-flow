interface PrivacyNoticeProps {
  projectRoot?: string;
  onClose: () => void;
}

export default function PrivacyNotice({ projectRoot, onClose }: PrivacyNoticeProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>🔒 Privacy — folder access</span>
          <button className="text-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {projectRoot ? (
            <p className="modal-hint privacy-path" title={projectRoot}>
              Currently open: <code className="inline-code">{projectRoot}</code>
            </p>
          ) : (
            <p className="modal-hint">No folder is currently open — nothing on disk is accessible right now.</p>
          )}

          <ul className="privacy-list">
            <li>DevTop Flow only reads files inside the folder <em>you</em> explicitly opened — never anywhere else on disk.</li>
            <li>
              File contents are sent to an AI model only when: you attach a file, or the assistant asks to read a
              specific file and you can see that request happen live in the chat (never silent).
            </li>
            <li>The assistant always sees the folder's file <em>names</em> (a tree) so it knows what exists — use 👁 @see in the chat panel to verify exactly what that looks like, any time.</li>
            <li>Sent content goes only to the AI provider you've configured (Anthropic, OpenAI, DeepSeek, or a local Ollama server) — never anywhere else.</li>
            <li>API keys live in the macOS Keychain, never in plaintext config.</li>
            <li>Chat history is saved to a <code className="inline-code">.devtopflow/</code> folder inside the project itself — nothing is uploaded except what's explicitly sent to the model.</li>
          </ul>

          <p className="modal-hint">
            Open this notice any time with <kbd className="kbd">⌘⇧P</kbd>, or close/reopen the folder to revoke and
            re-grant access.
          </p>
        </div>
      </div>
    </div>
  );
}

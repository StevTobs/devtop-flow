import { useState } from "react";
import { openExternalUrl } from "../lib/fileSystem";
import { ApiKeyProvider, deleteApiKey, saveApiKey } from "../lib/secrets";
import { useI18n } from "../lib/i18n";

interface SettingsProps {
  hasKey: Record<ApiKeyProvider, boolean>;
  ollamaModels: string[];
  /** Models Ollama itself reports as pulled (GET /api/tags) — populates the dropdown so there's nothing to type. */
  detectedOllamaModels: string[];
  /** null = hasn't checked yet; true/false = last check's result (like `curl http://host:port` succeeding or not). */
  ollamaRunning: boolean | null;
  /** Raw failure reason from the last check, if any — shown so a bad detection is diagnosable, not a dead end. */
  ollamaError?: string;
  ollamaBaseUrl: string;
  onOllamaBaseUrlChange: (baseUrl: string) => void;
  onRefreshOllamaModels: () => void;
  onAddOllamaModel: (model: string) => void;
  onRemoveOllamaModel: (model: string) => void;
  onClose: () => void;
  onKeysChanged: () => void;
}

const PROVIDER_LABELS: Record<ApiKeyProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  deepseek: "DeepSeek",
};

// Opens in the system browser, not embedded — the actual Google/email
// sign-in has to happen on Anthropic's real domain, not inside the app's
// webview. This only gets the user to their API key faster; it still has to
// be pasted into the field below like any other key (the Console page and
// the chat API are separate products, so signing in doesn't hand the app a
// working key by itself).
const PROVIDER_SIGNUP_URL: Partial<Record<ApiKeyProvider, string>> = {
  anthropic: "https://console.anthropic.com/login",
};

export default function Settings({
  hasKey,
  ollamaModels,
  detectedOllamaModels,
  ollamaRunning,
  ollamaError,
  ollamaBaseUrl,
  onOllamaBaseUrlChange,
  onRefreshOllamaModels,
  onAddOllamaModel,
  onRemoveOllamaModel,
  onClose,
  onKeysChanged,
}: SettingsProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<ApiKeyProvider, string>>({
    anthropic: "",
    openai: "",
    deepseek: "",
  });
  const [saving, setSaving] = useState<ApiKeyProvider | null>(null);
  const [ollamaSelected, setOllamaSelected] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [ollamaDraft, setOllamaDraft] = useState("");
  const [hostDraft, setHostDraft] = useState(ollamaBaseUrl);
  const [hostEditing, setHostEditing] = useState(false);

  const saveHost = () => {
    const url = hostDraft.trim() || ollamaBaseUrl;
    setHostDraft(url);
    onOllamaBaseUrlChange(url);
    setHostEditing(false);
  };

  const addOllamaModel = () => {
    const name = (manualEntry ? ollamaDraft : ollamaSelected).trim();
    if (!name) return;
    onAddOllamaModel(name);
    setOllamaDraft("");
    setOllamaSelected("");
  };

  const save = async (provider: ApiKeyProvider) => {
    const value = drafts[provider].trim();
    if (!value) return;
    setSaving(provider);
    try {
      await saveApiKey(provider, value);
      setDrafts((d) => ({ ...d, [provider]: "" }));
      onKeysChanged();
    } finally {
      setSaving(null);
    }
  };

  const clear = async (provider: ApiKeyProvider) => {
    setSaving(provider);
    try {
      await deleteApiKey(provider);
      onKeysChanged();
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("settings.title")}</span>
          <button className="text-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">{t("settings.hint")}</p>
          {(Object.keys(PROVIDER_LABELS) as ApiKeyProvider[]).map((provider) => (
            <div key={provider} className="settings-row">
              <label>{PROVIDER_LABELS[provider]}</label>
              <div className="settings-row-input">
                <input
                  type="password"
                  placeholder={hasKey[provider] ? t("settings.savedPlaceholder") : t("settings.pastePlaceholder")}
                  value={drafts[provider]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [provider]: e.target.value }))}
                />
                <button disabled={saving === provider || !drafts[provider].trim()} onClick={() => save(provider)}>
                  {t("settings.save")}
                </button>
                {hasKey[provider] && (
                  <button className="danger" disabled={saving === provider} onClick={() => clear(provider)}>
                    {t("settings.clear")}
                  </button>
                )}
              </div>
              {PROVIDER_SIGNUP_URL[provider] && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => openExternalUrl(PROVIDER_SIGNUP_URL[provider]!)}
                >
                  {t("settings.signIn")}
                </button>
              )}
            </div>
          ))}

          <div className="settings-row">
            <label>{t("settings.ollama")}</label>
            <div className="ollama-status">
              <span className={`ollama-status-dot ${ollamaRunning ? "running" : ollamaRunning === false ? "stopped" : ""}`} />
              {ollamaRunning === null && t("settings.ollamaChecking")}
              {ollamaRunning === true && t("settings.ollamaRunning", { url: ollamaBaseUrl })}
              {ollamaRunning === false && t("settings.ollamaNotReachable", { url: ollamaBaseUrl })}
              {!hostEditing && (
                <button type="button" className="text-btn" onClick={() => setHostEditing(true)}>
                  {t("settings.changeHost")}
                </button>
              )}
            </div>
            {ollamaRunning === false && ollamaError && <p className="ollama-error">{ollamaError}</p>}
            {hostEditing && (
              <div className="settings-row-input">
                <input
                  type="text"
                  placeholder={ollamaBaseUrl}
                  value={hostDraft}
                  onChange={(e) => setHostDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveHost();
                  }}
                />
                <button onClick={saveHost}>{t("settings.save")}</button>
              </div>
            )}
            {!manualEntry ? (
              <div className="settings-row-input">
                <select value={ollamaSelected} onChange={(e) => setOllamaSelected(e.target.value)}>
                  <option value="">
                    {detectedOllamaModels.length > 0
                      ? t("settings.selectModel")
                      : ollamaRunning === false
                      ? t("settings.ollamaNotRunning")
                      : t("settings.noModelsPulled")}
                  </option>
                  {detectedOllamaModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={onRefreshOllamaModels} title={t("settings.refreshTitle")}>
                  ↻
                </button>
                <button disabled={!ollamaSelected} onClick={addOllamaModel}>
                  {t("settings.save")}
                </button>
              </div>
            ) : (
              <div className="settings-row-input">
                <input
                  type="text"
                  placeholder={t("settings.modelNamePlaceholder")}
                  value={ollamaDraft}
                  onChange={(e) => setOllamaDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addOllamaModel();
                  }}
                />
                <button disabled={!ollamaDraft.trim()} onClick={addOllamaModel}>
                  {t("settings.save")}
                </button>
              </div>
            )}
            <button className="text-btn ollama-manual-toggle" onClick={() => setManualEntry((v) => !v)}>
              {manualEntry ? t("settings.manualOn") : t("settings.manualOff")}
            </button>
            {ollamaModels.length > 0 && (
              <ul className="ollama-model-list">
                {ollamaModels.map((model) => (
                  <li key={model}>
                    <span>{model}</span>
                    <button className="danger" onClick={() => onRemoveOllamaModel(model)}>
                      {t("settings.clear")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

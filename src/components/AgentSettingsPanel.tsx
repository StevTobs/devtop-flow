import { useState } from "react";
import { ModelProvider, ThinkingMode } from "../lib/modelProvider";
import {
  AgentSettings,
  BUILTIN_PRESETS,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
} from "../lib/agentSettings";

interface AgentSettingsPanelProps {
  settings: AgentSettings;
  scope: "global" | "chat";
  hasChatOverride: boolean;
  onScopeChange: (scope: "global" | "chat") => void;
  onClearChatOverride: () => void;
  onChange: (patch: Partial<AgentSettings>) => void;
  onApplyPreset: (settings: AgentSettings) => void;
  providers: ModelProvider[];
  activeProviderId?: string;
  onSelectProvider: (id: string) => void;
  onManageApiKeys: () => void;
  onClose: () => void;
}

const THINKING_MODES: ThinkingMode[] = ["off", "low", "medium", "high"];

export default function AgentSettingsPanel({
  settings,
  scope,
  hasChatOverride,
  onScopeChange,
  onClearChatOverride,
  onChange,
  onApplyPreset,
  providers,
  activeProviderId,
  onSelectProvider,
  onManageApiKeys,
  onClose,
}: AgentSettingsPanelProps) {
  const [customPresets, setCustomPresets] = useState(loadCustomPresets());
  const activeProvider = providers.find((p) => p.id === activeProviderId);

  const applyPresetByName = (name: string) => {
    const preset = BUILTIN_PRESETS[name] ?? customPresets[name];
    if (preset) onApplyPreset(preset);
  };

  const saveAsPreset = () => {
    const name = prompt("Preset name:");
    if (!name?.trim()) return;
    setCustomPresets(saveCustomPreset(name.trim(), settings));
  };

  const removePreset = (name: string) => {
    if (!confirm(`Delete preset "${name}"?`)) return;
    setCustomPresets(deleteCustomPreset(name));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal agent-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Agent Settings</span>
          <button className="text-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body agent-settings-body">
          <div className="agent-settings-scope">
            <label>
              <input type="radio" checked={scope === "global"} onChange={() => onScopeChange("global")} />
              Global default
            </label>
            <label>
              <input type="radio" checked={scope === "chat"} onChange={() => onScopeChange("chat")} />
              This chat only {hasChatOverride && <span className="scope-badge">overridden</span>}
            </label>
            {scope === "chat" && hasChatOverride && (
              <button className="text-btn" onClick={onClearChatOverride}>
                Clear override
              </button>
            )}
          </div>

          <div className="agent-settings-section">
            <div className="agent-settings-section-title">Model</div>
            <div className="settings-row">
              <label>Provider / model</label>
              <select
                className="model-select-compact agent-settings-select"
                value={activeProviderId ?? ""}
                onChange={(e) => onSelectProvider(e.target.value)}
                disabled={providers.length === 0}
              >
                {providers.length === 0 && <option value="">No model configured</option>}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.kind === "local" ? "🖥️ " : "☁️ "}
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="text-btn" onClick={onManageApiKeys}>
              🔑 Manage API keys…
            </button>
            {activeProvider?.kind === "local" && (
              <p className="modal-hint">Local models run with no API key and no per-token cost.</p>
            )}
          </div>

          <div className="agent-settings-section">
            <div className="agent-settings-section-title">Context</div>
            <div className="settings-row">
              <label>Context window limit — {settings.contextLimit.toLocaleString()} tokens</label>
              <input
                type="range"
                min={4000}
                max={200000}
                step={1000}
                value={settings.contextLimit}
                onChange={(e) => onChange({ contextLimit: Number(e.target.value) })}
              />
            </div>
            <div className="settings-row settings-row-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={settings.includeOpenFile}
                  onChange={(e) => onChange({ includeOpenFile: e.target.checked })}
                />
                Include open file automatically
              </label>
            </div>
            <div className="settings-row settings-row-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={settings.includeWorkspaceTree}
                  onChange={(e) => onChange({ includeWorkspaceTree: e.target.checked })}
                />
                Include workspace tree
              </label>
            </div>
            <div className="settings-row">
              <label>Max files to auto-attach — {settings.maxAutoAttachFiles}</label>
              <input
                type="number"
                min={1}
                max={50}
                value={settings.maxAutoAttachFiles}
                onChange={(e) => onChange({ maxAutoAttachFiles: Number(e.target.value) || 1 })}
              />
            </div>
          </div>

          <div className="agent-settings-section">
            <div className="agent-settings-section-title">Reasoning / Effort</div>
            <div className="settings-row">
              <label>Thinking mode</label>
              <select
                className="agent-settings-select"
                value={settings.thinkingMode}
                onChange={(e) => onChange({ thinkingMode: e.target.value as ThinkingMode })}
              >
                {THINKING_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m[0].toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            {settings.thinkingMode !== "off" && (
              <div className="settings-row">
                <label>Max thinking tokens — {settings.maxThinkingTokens.toLocaleString()}</label>
                <input
                  type="range"
                  min={1024}
                  max={32000}
                  step={512}
                  value={settings.maxThinkingTokens}
                  onChange={(e) => onChange({ maxThinkingTokens: Number(e.target.value) })}
                />
              </div>
            )}
            <div className="settings-row">
              <label>Temperature — {settings.temperature.toFixed(2)}</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.temperature}
                disabled={settings.thinkingMode !== "off"}
                onChange={(e) => onChange({ temperature: Number(e.target.value) })}
              />
              {settings.thinkingMode !== "off" && (
                <p className="modal-hint">Fixed at the model default while thinking is on.</p>
              )}
            </div>
          </div>

          <div className="agent-settings-section">
            <div className="agent-settings-section-title">Response Limits</div>
            <div className="settings-row">
              <label>Max output tokens</label>
              <input
                type="number"
                min={256}
                max={32000}
                value={settings.maxOutputTokens}
                onChange={(e) => onChange({ maxOutputTokens: Number(e.target.value) || 256 })}
              />
            </div>
            <div className="settings-row">
              <label>Max tool calls per turn</label>
              <input
                type="number"
                min={1}
                max={50}
                value={settings.maxToolCallsPerTurn}
                onChange={(e) => onChange({ maxToolCallsPerTurn: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="settings-row">
              <label>Max turns per task</label>
              <input
                type="number"
                min={1}
                max={30}
                value={settings.maxTurnsPerTask}
                onChange={(e) => onChange({ maxTurnsPerTask: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="settings-row">
              <label>Turn stall timeout — {Math.round(settings.turnTimeoutMs / 1000)}s</label>
              <input
                type="range"
                min={15000}
                max={180000}
                step={5000}
                value={settings.turnTimeoutMs}
                onChange={(e) => onChange({ turnTimeoutMs: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="agent-settings-section">
            <div className="agent-settings-section-title">Custom Instructions</div>
            <div className="settings-row">
              <label>System prompt override</label>
              <textarea
                className="agent-settings-textarea"
                rows={3}
                placeholder="Extra instructions added to every request in this scope…"
                value={settings.systemPromptOverride}
                onChange={(e) => onChange({ systemPromptOverride: e.target.value })}
              />
            </div>
            <div className="agent-settings-presets">
              <select className="agent-settings-select" defaultValue="" onChange={(e) => e.target.value && applyPresetByName(e.target.value)}>
                <option value="">Load preset…</option>
                <optgroup label="Built-in">
                  {Object.keys(BUILTIN_PRESETS).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
                {Object.keys(customPresets).length > 0 && (
                  <optgroup label="Custom">
                    {Object.keys(customPresets).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button className="text-btn" onClick={saveAsPreset}>
                💾 Save as preset
              </button>
              {Object.keys(customPresets).map((name) => (
                <button key={name} className="text-btn danger preset-delete" onClick={() => removePreset(name)} title={`Delete "${name}"`}>
                  🗑 {name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";

// Thin wrapper around the Rust-side save_api_key / get_api_key / delete_api_key
// commands (src-tauri/src/main.rs), which store keys in the macOS Keychain via
// the `keyring` crate — never in plaintext config (build plan §3, §8).

export type ApiKeyProvider = "anthropic" | "openai" | "deepseek";

export async function saveApiKey(provider: ApiKeyProvider, key: string): Promise<void> {
  await invoke("save_api_key", { provider, key });
}

export async function getApiKey(provider: ApiKeyProvider): Promise<string | undefined> {
  const value = await invoke<string | null>("get_api_key", { provider });
  return value ?? undefined;
}

export async function deleteApiKey(provider: ApiKeyProvider): Promise<void> {
  await invoke("delete_api_key", { provider });
}

export async function loadAllApiKeys(): Promise<Record<ApiKeyProvider, string | undefined>> {
  const [anthropic, openai, deepseek] = await Promise.all([
    getApiKey("anthropic"),
    getApiKey("openai"),
    getApiKey("deepseek"),
  ]);
  return { anthropic, openai, deepseek };
}

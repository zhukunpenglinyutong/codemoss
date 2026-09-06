/** Shared provider model for the CLI config section. */

export const ENGINE_IDS = ["claude", "kimi", "grok", "codex", "pi", "omp", "dsh"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const PSEUDO_LOCAL = "__local_settings_json__";
export const PSEUDO_DISABLED = "__disabled__";
/** Pseudo providers pinned at the top of every engine's list. */
export const PSEUDO_PROVIDER_IDS = [PSEUDO_LOCAL, PSEUDO_DISABLED] as const;
export type PseudoProviderId = (typeof PSEUDO_PROVIDER_IDS)[number];

export const isPseudoProvider = (id: string): id is PseudoProviderId =>
  (PSEUDO_PROVIDER_IDS as readonly string[]).includes(id);

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  remark: string;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Tolerantly parse a provider JSON blob from the config file. */
export function parseProvider(id: string, raw: unknown): ProviderEntry {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id,
    name: asString(o.name) || id,
    baseUrl: asString(o.baseUrl),
    apiKey: asString(o.apiKey),
    model: asString(o.model),
    remark: asString(o.remark),
  };
}
/** Per-engine model env var, mirroring the backend env_mapping() table. */
const ENV_MODEL_KEY: Partial<Record<EngineId, string>> = {
  claude: "ANTHROPIC_MODEL",
  kimi: "KIMI_MODEL_NAME",
  grok: "GROK_MODEL",
};

/**
 * Model id for the picker: the flat `model` field first, then the legacy
 * imported shape (`settingsConfig.env.<ENGINE_MODEL_VAR>` / `env.<…>`).
 */
export function providerModel(engine: EngineId, raw: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flat = asString(o.model).trim();
  if (flat) return flat;
  const key = ENV_MODEL_KEY[engine];
  if (!key) return "";
  const settingsEnv = (o.settingsConfig as Record<string, unknown> | undefined)?.env;
  for (const source of [settingsEnv, o.env]) {
    if (source && typeof source === "object") {
      const value = asString((source as Record<string, unknown>)[key]).trim();
      if (value) return value;
    }
  }
  return "";
}

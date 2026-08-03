/**
 * 供应商配置相关类型定义
 * 数据格式与 idea-claude-code-gui 项目完全兼容
 */

// model id 校验的单一事实源为 composer/types/provider(长度 ≤128 + pattern 校验);
// 此处经 import 别名再导出,保持 vendors feature 既有导入路径与函数引用不变,
// 避免两份漂移的实现。
import {
  MODEL_ID_PATTERN as COMPOSER_MODEL_ID_PATTERN,
  isValidModelId as isValidComposerModelId,
} from "../composer/types/provider";
import { STORAGE_KEYS as MODEL_STORAGE_KEYS } from "../models/constants";

// ============ Constants ============

export const STORAGE_KEYS = {
  CODEX_CUSTOM_MODELS: 'codex-custom-models',
  CLAUDE_CUSTOM_MODELS: 'claude-custom-models',
  GEMINI_CUSTOM_MODELS: 'gemini-custom-models',
  /** @deprecated Use STORAGE_KEYS from features/models/constants instead for model mapping */
  CLAUDE_MODEL_MAPPING: MODEL_STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
} as const;

export const LOCAL_SETTINGS_PROVIDER_ID = "__local_settings_json__";

/** 「取消授权」伪供应商 id: 仅用于清空 current 标记, 不会出现在供应商列表中 */
export const DISABLED_PROVIDER_ID = "__disabled__";

export const LOCAL_KIMI_PROVIDER_ID = "__local_config_toml__";

export const LOCAL_GROK_PROVIDER_ID = "__local_config_toml__";

export const LOCAL_OPENCODE_PROVIDER_ID = "__local_opencode_json__";

// ============ Validation Helpers ============

export const MODEL_ID_PATTERN = COMPOSER_MODEL_ID_PATTERN;
export const isValidModelId = isValidComposerModelId;

export function isValidCodexCustomModel(model: unknown): model is CodexCustomModel {
  if (!model || typeof model !== 'object') return false;
  const obj = model as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !isValidModelId(obj.id)) return false;
  if (typeof obj.label !== 'string' || obj.label.trim().length === 0) return false;
  if (obj.description !== undefined && typeof obj.description !== 'string') return false;
  if (obj.providerProfileId !== undefined && typeof obj.providerProfileId !== 'string') return false;
  return true;
}

export function validateCodexCustomModels(models: unknown): CodexCustomModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter(isValidCodexCustomModel);
}

// ============ Types ============

export type ProviderCategory =
  | 'official'
  | 'cn_official'
  | 'aggregator'
  | 'third_party'
  | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  category?: ProviderCategory;
  createdAt?: number;
  sortOrder?: number;
  isActive?: boolean;
  source?: 'cc-switch' | string;
  isLocalProvider?: boolean;
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      ANTHROPIC_MODEL?: string;
      ANTHROPIC_DEFAULT_FABLE_MODEL?: string;
      ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
      ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
      ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
      [key: string]: string | undefined;
    };
    alwaysThinkingEnabled?: boolean;
    autoDreamEnabled?: boolean;
    cleanupPeriodDays?: number;
    effortLevel?: string;
    hasCompletedOnboarding?: boolean;
    language?: string;
    model?: string;
    skipAutoPermissionPrompt?: boolean;
    teammateMode?: string;
    tui?: string;
    permissions?: {
      allow?: string[];
      deny?: string[];
    };
    [key: string]: unknown;
  };
}

export interface CodexCustomModel {
  id: string;
  label: string;
  description?: string;
  providerProfileId?: string;
}

export interface ClaudeCurrentConfig {
  apiKey: string;
  baseUrl: string;
  authType?: string;
  providerId?: string;
  providerName?: string;
}

export interface CodexProviderConfig {
  id: string;
  name: string;
  remark?: string;
  createdAt?: number;
  sortOrder?: number;
  isActive?: boolean;
  source?: string;
  configToml?: string;
  authJson?: string;
  customModels?: CodexCustomModel[];
}

export interface KimiProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  createdAt?: number;
  sortOrder?: number;
  isActive?: boolean;
  isLocalProvider?: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerType?: string;
  maxContextSize?: number;
  displayName?: string;
}

export interface KimiCurrentConfig {
  apiKey: string;
  baseUrl: string;
  authType?: string;
  defaultModel: string;
  providerId?: string;
  providerName?: string;
  configStatus?: "missing" | "loaded" | "malformed" | "io-error";
  diagnostic?: string;
}

export interface KimiProviderDeleteResult {
  status: "success" | "partial-warning";
  warning?: string;
}

export type GrokApiBackend = "chat_completions" | "responses" | "messages";

export interface GrokProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  createdAt?: number;
  sortOrder?: number;
  isActive?: boolean;
  isLocalProvider?: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerType?: string;
  /** grok config.toml 的 api_backend 字段,默认 chat_completions */
  apiBackend?: GrokApiBackend | string;
  maxContextSize?: number;
  displayName?: string;
}

export interface GrokCurrentConfig {
  apiKey: string;
  baseUrl: string;
  authType?: string;
  defaultModel: string;
  providerId?: string;
  providerName?: string;
  configStatus?: "missing" | "loaded" | "malformed" | "io-error";
  diagnostic?: string;
}

export interface GrokProviderDeleteResult {
  status: "success" | "partial-warning";
  warning?: string;
}

export interface OpenCodeProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  createdAt?: number;
  sortOrder?: number;
  isActive?: boolean;
  isLocalProvider?: boolean;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface OpenCodeCurrentConfig {
  apiKey: string;
  baseUrl: string;
  authType?: string;
  defaultModel: string;
  providerId?: string;
  providerName?: string;
  configStatus?: "missing" | "loaded" | "malformed" | "io-error";
  diagnostic?: string;
}

export const GEMINI_AUTH_MODES = [
  "custom",
  "login_google",
  "gemini_api_key",
  "vertex_adc",
  "vertex_service_account",
  "vertex_api_key",
] as const;

export type GeminiAuthMode = (typeof GEMINI_AUTH_MODES)[number];

export interface GeminiVendorDraft {
  enabled: boolean;
  envText: string;
  authMode: GeminiAuthMode;
  apiBaseUrl: string;
  geminiApiKey: string;
  googleApiKey: string;
  googleCloudProject: string;
  googleCloudLocation: string;
  googleApplicationCredentials: string;
  model: string;
}

export type VendorTab = "claude" | "codex" | "kimi" | "grok" | "opencode";

export interface ClaudeProviderPreset {
  id: string;
  nameKey: string;
  env: Record<string, string>;
}

/** 官方直连预设 id: 选中时 API URL 锁定为 Anthropic 官方端点 */
export const OFFICIAL_DIRECT_PRESET_ID = "official_direct";
export const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export const CLAUDE_PROVIDER_PRESETS: ClaudeProviderPreset[] = [
  {
    id: "custom",
    nameKey: "settings.vendor.presets.custom",
    env: {},
  },
  {
    id: "zhipu",
    nameKey: "settings.vendor.presets.zhipu",
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
    },
  },
  {
    id: "kimi",
    nameKey: "settings.vendor.presets.kimi",
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
    },
  },
  {
    id: "kimi-coding",
    nameKey: "settings.vendor.presets.kimiCoding",
    env: {
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
    },
  },
  {
    id: "deepseek",
    nameKey: "settings.vendor.presets.deepseek",
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    },
  },
  {
    id: "minimax",
    nameKey: "settings.vendor.presets.minimax",
    env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      // MiniMax 模型响应较慢, 需要 50 分钟 (3,000,000ms) 超时避免长推理请求被截断
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.1",
    },
  },
  {
    id: "xiaomi",
    nameKey: "settings.vendor.presets.xiaomi",
    env: {
      ANTHROPIC_BASE_URL: "https://api.xiaomimimo.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.5-pro",
    },
  },
  {
    id: "xiaomi-plan",
    nameKey: "settings.vendor.presets.xiaomiPlan",
    env: {
      ANTHROPIC_BASE_URL: "https://token-plan-cn.xiaomimimo.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.5-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.5-pro",
    },
  },
  {
    id: "bailian",
    nameKey: "settings.vendor.presets.bailian",
    env: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
    },
  },
  {
    id: "bailian-coding",
    nameKey: "settings.vendor.presets.bailianCoding",
    env: {
      ANTHROPIC_BASE_URL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
    },
  },
  {
    id: "longcat",
    nameKey: "settings.vendor.presets.longcat",
    env: {
      ANTHROPIC_BASE_URL: "https://api.longcat.chat/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "LongCat-2.0",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "LongCat-2.0",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "LongCat-2.0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "LongCat-2.0",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  {
    id: "opencode-go",
    nameKey: "settings.vendor.presets.opencodeGo",
    env: {
      ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash",
    },
  },
  {
    id: "openrouter",
    nameKey: "settings.vendor.presets.openrouter",
    env: {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "anthropic/claude-fable-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.5",
    },
  },
];

// ============ Codex Provider Presets ============

export interface CodexProviderPreset {
  id: string;
  name: string;
  nameKey: string;
  configToml: string;
  authJson: string;
}

const tomlString = (value: string): string => JSON.stringify(value);

export function buildCodexProviderConfigToml(
  providerName: string,
  baseUrl: string,
  model: string,
  wireApi: "responses" | "chat" = "responses",
  providerId = "custom",
): string {
  return `disable_response_storage = true
model = ${tomlString(model)}
model_reasoning_effort = "high"
model_provider = ${tomlString(providerId)}

[model_providers.${providerId}]
base_url = ${tomlString(baseUrl)}
name = ${tomlString(providerName)}
requires_openai_auth = true
wire_api = ${tomlString(wireApi)}`;
}

export const DEFAULT_CODEX_AUTH_JSON = `{
  "OPENAI_API_KEY": ""
}`;

export const DEFAULT_CODEX_CONFIG_TOML = buildCodexProviderConfigToml(
  "crs",
  "https://api.example.com/v1",
  "gpt-5.1-codex",
  "responses",
  "crs",
);

export const OFFICIAL_CODEX_PROVIDER_NAME = "OpenAI Official Direct";
export const OFFICIAL_CODEX_BASE_URL = "https://api.openai.com/v1";
export const OFFICIAL_CODEX_CONFIG_TOML = buildCodexProviderConfigToml(
  "openai",
  OFFICIAL_CODEX_BASE_URL,
  "gpt-5.1-codex",
  "responses",
  "openai",
);

export const CODEX_PROVIDER_PRESETS: CodexProviderPreset[] = [
  {
    id: "custom",
    name: "",
    nameKey: "settings.vendor.presets.custom",
    configToml: DEFAULT_CODEX_CONFIG_TOML,
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    nameKey: "settings.vendor.presets.zhipu",
    configToml: buildCodexProviderConfigToml("zhipu_glm", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.2", "chat"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "kimi",
    name: "Kimi",
    nameKey: "settings.vendor.presets.kimi",
    configToml: buildCodexProviderConfigToml("kimi", "https://api.moonshot.cn/v1", "kimi-k3", "chat"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "kimi-coding",
    name: "Kimi Coding",
    nameKey: "settings.vendor.presets.kimiCoding",
    configToml: buildCodexProviderConfigToml("kimi_coding", "https://api.kimi.com/coding/v1", "kimi-k3", "chat"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    nameKey: "settings.vendor.presets.deepseek",
    configToml: buildCodexProviderConfigToml("deepseek", "https://api.deepseek.com", "deepseek-v4-flash", "chat"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "atlas-cloud",
    name: "Atlas Cloud",
    nameKey: "settings.vendor.presets.atlasCloud",
    configToml: buildCodexProviderConfigToml(
      "atlas_cloud",
      "https://api.atlascloud.ai/v1",
      "deepseek-ai/deepseek-v4-pro",
      "chat",
      "atlas_cloud",
    ),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "minimax",
    name: "MiniMax",
    nameKey: "settings.vendor.presets.minimax",
    configToml: buildCodexProviderConfigToml("minimax", "https://api.minimaxi.com/v1", "MiniMax-M3"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    nameKey: "settings.vendor.presets.xiaomi",
    configToml: buildCodexProviderConfigToml("xiaomi_mimo", "https://api.xiaomimimo.com/v1", "mimo-v2.5-pro"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "xiaomi-plan",
    name: "Xiaomi MiMo Plan",
    nameKey: "settings.vendor.presets.xiaomiPlan",
    configToml: buildCodexProviderConfigToml("xiaomi_mimo_token_plan", "https://token-plan-cn.xiaomimimo.com/v1", "mimo-v2.5-pro"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "bailian",
    name: "Bailian",
    nameKey: "settings.vendor.presets.bailian",
    configToml: buildCodexProviderConfigToml("bailian", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-coder-plus"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "bailian-coding",
    name: "Bailian Coding",
    nameKey: "settings.vendor.presets.bailianCoding",
    configToml: buildCodexProviderConfigToml("bailian_coding", "https://coding.dashscope.aliyuncs.com/v1", "qwen3-coder-plus"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "longcat",
    name: "LongCat",
    nameKey: "settings.vendor.presets.longcat",
    configToml: buildCodexProviderConfigToml("longcat", "https://api.longcat.chat/openai/v1", "LongCat-2.0"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    nameKey: "settings.vendor.presets.opencodeGo",
    configToml: buildCodexProviderConfigToml("opencode_go", "https://opencode.ai/zen/go/v1", "glm-5.2", "chat"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    nameKey: "settings.vendor.presets.openrouter",
    configToml: buildCodexProviderConfigToml("openrouter", "https://openrouter.ai/api/v1", "gpt-5.6-sol"),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
];

export interface KimiProviderPreset {
  id: string;
  nameKey: string;
  baseUrl: string;
  providerType: string;
  model: string;
  maxContextSize?: number;
}

export const KIMI_PROVIDER_PRESETS: KimiProviderPreset[] = [
  {
    id: "kimi-coding",
    nameKey: "settings.vendor.kimiPresets.kimiCoding",
    baseUrl: "https://api.kimi.com/coding/v1",
    providerType: "kimi",
    model: "kimi-for-coding",
    maxContextSize: 262144,
  },
  {
    id: "moonshot",
    nameKey: "settings.vendor.kimiPresets.moonshotOpenPlatform",
    baseUrl: "https://api.moonshot.cn/v1",
    providerType: "openai",
    model: "",
  },
  {
    id: "custom",
    nameKey: "settings.vendor.kimiPresets.custom",
    baseUrl: "",
    providerType: "openai",
    model: "",
  },
];

export interface GrokProviderPreset {
  id: string;
  nameKey: string;
  baseUrl: string;
  apiBackend: GrokApiBackend;
  model: string;
  maxContextSize?: number;
}

export const GROK_PROVIDER_PRESETS: GrokProviderPreset[] = [
  {
    id: "xai-official",
    nameKey: "settings.vendor.grokPresets.xaiOfficial",
    baseUrl: "https://api.x.ai/v1",
    apiBackend: "responses",
    model: "grok-build",
  },
  {
    id: "custom",
    nameKey: "settings.vendor.grokPresets.custom",
    baseUrl: "",
    apiBackend: "chat_completions",
    model: "",
  },
];

export interface OpenCodeProviderPreset {
  id: string;
  nameKey: string;
  baseUrl: string;
  models: string[];
}

export const OPENCODE_PROVIDER_PRESETS: OpenCodeProviderPreset[] = [
  {
    id: "opencode-zen",
    nameKey: "settings.vendor.opencodePresets.opencodeZen",
    baseUrl: "https://opencode.ai/zen/v1",
    models: [],
  },
  {
    id: "custom",
    nameKey: "settings.vendor.opencodePresets.custom",
    baseUrl: "",
    models: [],
  },
];

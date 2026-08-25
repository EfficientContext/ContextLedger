import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.js";

export const ProviderIdSchema = z.enum([
  "cli",
  "openai",
  "deepseek",
  "kimi",
  "glm",
  "custom",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ApiModeSchema = z.enum(["responses", "chat_completions"]);
export type ApiMode = z.infer<typeof ApiModeSchema>;

export const ModelProviderConfigSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().trim().default(""),
  baseUrl: z.string().trim().default(""),
  apiMode: ApiModeSchema.default("chat_completions"),
  apiKey: z.string().trim().optional(),
  cliCommand: z.string().trim().optional(),
  cliKind: z.enum(["claude", "codex"]).optional(),
  updatedAt: z.string().datetime(),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;

const ModelProviderStoreSchema = z.object({
  version: z.literal(1),
  activeProvider: ProviderIdSchema,
  providers: z.partialRecord(ProviderIdSchema, ModelProviderConfigSchema),
});
type ModelProviderStore = z.infer<typeof ModelProviderStoreSchema>;

export type ProviderPreset = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiMode: ApiMode;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
  supportsModelDiscovery: boolean;
};

export const MODEL_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "cli",
    label: "Codex / Claude CLI 登录",
    baseUrl: "",
    apiMode: "responses",
    defaultModel: "",
    suggestedModels: [],
    requiresApiKey: false,
    supportsModelDiscovery: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiMode: "responses",
    defaultModel: "gpt-5.6-terra",
    suggestedModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiMode: "chat_completions",
    defaultModel: "deepseek-v4-pro",
    suggestedModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    apiMode: "chat_completions",
    defaultModel: "kimi-k2.5",
    suggestedModels: ["kimi-k2.5"],
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  {
    id: "glm",
    label: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiMode: "chat_completions",
    defaultModel: "glm-5.1",
    suggestedModels: ["glm-5.1"],
    requiresApiKey: true,
    supportsModelDiscovery: true,
  },
  {
    id: "custom",
    label: "自定义 OpenAI-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiMode: "chat_completions",
    defaultModel: "",
    suggestedModels: [],
    requiresApiKey: false,
    supportsModelDiscovery: true,
  },
];

function presetFor(provider: ProviderId): ProviderPreset {
  return MODEL_PROVIDER_PRESETS.find((item) => item.id === provider)!;
}

function configPath(home = loadConfig().CONTEXT_LEDGER_HOME): string {
  return join(home, ".local", "model-provider.json");
}

function defaultConfig(provider: ProviderId): ModelProviderConfig {
  const preset = presetFor(provider);
  return {
    provider,
    model: preset.defaultModel,
    baseUrl: preset.baseUrl,
    apiMode: preset.apiMode,
    updatedAt: new Date(0).toISOString(),
  };
}

function defaultStore(): ModelProviderStore {
  return {
    version: 1,
    activeProvider: "cli",
    providers: { cli: defaultConfig("cli") },
  };
}

async function readStore(home?: string): Promise<ModelProviderStore> {
  try {
    return ModelProviderStoreSchema.parse(
      JSON.parse(await readFile(configPath(home), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultStore();
    }
    throw error;
  }
}

async function writeStore(
  store: ModelProviderStore,
  home?: string,
): Promise<void> {
  const path = configPath(home);
  const directory = join(path, "..");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function loadActiveModelProvider(
  home?: string,
): Promise<ModelProviderConfig> {
  const store = await readStore(home);
  return (
    store.providers[store.activeProvider] ?? defaultConfig(store.activeProvider)
  );
}

export async function saveModelProvider(
  input: {
    provider: ProviderId;
    model?: string | undefined;
    baseUrl?: string | undefined;
    apiMode?: ApiMode | undefined;
    apiKey?: string | undefined;
    clearApiKey?: boolean | undefined;
    cliCommand?: string | undefined;
    cliKind?: "claude" | "codex" | undefined;
  },
  home?: string,
): Promise<ModelProviderConfig> {
  const store = await readStore(home);
  const previous =
    store.providers[input.provider] ?? defaultConfig(input.provider);
  const preset = presetFor(input.provider);
  const baseUrl = (input.baseUrl ?? previous.baseUrl ?? preset.baseUrl)
    .trim()
    .replace(/\/+$/u, "");
  const model = (input.model ?? previous.model ?? preset.defaultModel).trim();
  if (input.provider !== "cli") {
    if (!baseUrl) throw new Error("API base URL is required");
    z.string().url().parse(baseUrl);
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("Do not put credentials in the API base URL");
    }
    if (parsedUrl.search || parsedUrl.hash) {
      throw new Error("The API base URL must not contain a query or fragment");
    }
    if (!model) throw new Error("Model name is required");
  }
  const next: ModelProviderConfig = {
    provider: input.provider,
    model,
    baseUrl,
    apiMode: input.apiMode ?? previous.apiMode ?? preset.apiMode,
    updatedAt: new Date().toISOString(),
    ...((
      input.clearApiKey ? undefined : input.apiKey?.trim() || previous.apiKey
    )
      ? { apiKey: (input.apiKey?.trim() || previous.apiKey)! }
      : {}),
    ...(input.cliCommand?.trim()
      ? { cliCommand: input.cliCommand.trim() }
      : previous.cliCommand
        ? { cliCommand: previous.cliCommand }
        : {}),
    ...(input.cliKind
      ? { cliKind: input.cliKind }
      : previous.cliKind
        ? { cliKind: previous.cliKind }
        : {}),
  };
  if (input.provider !== "cli" && preset.requiresApiKey && !next.apiKey) {
    throw new Error(`${preset.label} API key is required`);
  }
  store.activeProvider = input.provider;
  store.providers[input.provider] = ModelProviderConfigSchema.parse(next);
  await writeStore(store, home);
  return next;
}

export async function resetModelProvider(home?: string): Promise<void> {
  const path = configPath(home);
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function sanitizeModelProvider(config: ModelProviderConfig): {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiMode: ApiMode;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  cliCommand: string | null;
  cliKind: "claude" | "codex" | null;
  updatedAt: string;
} {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiMode: config.apiMode,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : null,
    cliCommand: config.cliCommand ?? null,
    cliKind: config.cliKind ?? null,
    updatedAt: config.updatedAt,
  };
}

export async function listConfiguredModelProviders(
  home?: string,
): Promise<
  Partial<Record<ProviderId, ReturnType<typeof sanitizeModelProvider>>>
> {
  const store = await readStore(home);
  return Object.fromEntries(
    Object.entries(store.providers).map(([provider, config]) => [
      provider,
      sanitizeModelProvider(config),
    ]),
  );
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function authHeaders(config: ModelProviderConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

async function providerFetch(
  config: ModelProviderConfig,
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(
        `${presetFor(config.provider).label} request failed (${response.status}): ${detail || response.statusText}`,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverProviderModels(
  config: ModelProviderConfig,
): Promise<string[]> {
  if (config.provider === "cli") return config.model ? [config.model] : [];
  const response = await providerFetch(
    config,
    endpoint(config.baseUrl, "models"),
    { method: "GET", headers: authHeaders(config) },
  );
  const payload = z
    .object({
      data: z.array(z.object({ id: z.string().min(1) })).default([]),
    })
    .passthrough()
    .parse(await response.json());
  return [...new Set(payload.data.map((item) => item.id))].sort();
}

export async function generateWithModelProvider(
  config: ModelProviderConfig,
  input: {
    instructions: string;
    content: string;
    schema: Record<string, unknown>;
  },
): Promise<string> {
  if (config.provider === "cli") {
    throw new Error("CLI providers must be invoked through the local writer");
  }
  if (!config.model || !config.baseUrl) {
    throw new Error("The active model provider is incomplete");
  }
  const url = endpoint(
    config.baseUrl,
    config.apiMode === "responses" ? "responses" : "chat/completions",
  );
  const body =
    config.apiMode === "responses"
      ? {
          model: config.model,
          instructions: input.instructions,
          input: input.content,
          max_output_tokens: 64_000,
          text: {
            format: {
              type: "json_schema",
              name: "context_ledger_range_report",
              strict: true,
              schema: input.schema,
            },
          },
        }
      : {
          model: config.model,
          messages: [
            { role: "system", content: input.instructions },
            { role: "user", content: input.content },
          ],
          response_format: { type: "json_object" },
        };
  const response = await providerFetch(
    config,
    url,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body),
    },
    Number(process.env.CONTEXT_LEDGER_WRITER_TIMEOUT_MS ?? 360_000),
  );
  return extractProviderOutput(await response.json(), config.apiMode);
}

export function extractProviderOutput(
  payload: unknown,
  apiMode: ApiMode,
): string {
  if (apiMode === "chat_completions") {
    const parsed = z
      .object({
        choices: z.array(
          z.object({
            message: z.object({
              content: z.union([
                z.string(),
                z.array(
                  z.object({ text: z.string().optional() }).passthrough(),
                ),
              ]),
            }),
          }),
        ),
      })
      .parse(payload);
    const content = parsed.choices[0]?.message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => item.text ?? "")
        .join("")
        .trim();
      if (text) return text;
    }
    throw new Error("The model returned no text output");
  }

  const response = z
    .object({
      output_text: z.string().optional(),
      output: z
        .array(
          z
            .object({
              content: z
                .array(z.object({ text: z.string().optional() }).passthrough())
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .parse(payload);
  const text =
    response.output_text?.trim() ||
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("")
      .trim();
  if (!text) throw new Error("The model returned no text output");
  return text;
}

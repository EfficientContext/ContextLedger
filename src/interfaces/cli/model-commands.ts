import type { Command } from "commander";
import { z } from "zod";
import {
  ApiModeSchema,
  discoverProviderModels,
  loadActiveModelProvider,
  MODEL_PROVIDER_PRESETS,
  ProviderIdSchema,
  resetModelProvider,
  sanitizeModelProvider,
  saveModelProvider,
} from "../../infrastructure/model-provider.js";

async function printStatus(json = false): Promise<void> {
  const active = sanitizeModelProvider(await loadActiveModelProvider());
  if (json) {
    process.stdout.write(`${JSON.stringify({ active }, null, 2)}\n`);
    return;
  }
  const preset = MODEL_PROVIDER_PRESETS.find(
    (item) => item.id === active.provider,
  )!;
  process.stdout.write(`Provider: ${preset.label} (${active.provider})\n`);
  if (active.provider === "cli") {
    process.stdout.write(
      `CLI: ${active.cliCommand ?? "auto-detect tclaude, claude, tcodex, or codex"}\n`,
    );
    return;
  }
  process.stdout.write(`Model: ${active.model}\n`);
  process.stdout.write(`Endpoint: ${active.baseUrl}\n`);
  process.stdout.write(`API mode: ${active.apiMode}\n`);
  process.stdout.write(
    `API key: ${active.apiKeyHint ?? (preset.requiresApiKey ? "not configured" : "not required")}\n`,
  );
}

export function registerModelCommands(program: Command): void {
  const model = program
    .command("model")
    .description("Choose the model used to write time-range reports")
    .option("--json", "Print machine-readable status")
    .action(async (options: { json?: boolean }) => printStatus(options.json));

  model
    .command("status")
    .description("Show the active report model without exposing its API key")
    .option("--json", "Print machine-readable status")
    .action(async (options: { json?: boolean }) => printStatus(options.json));

  model
    .command("set")
    .description("Configure and activate a report model")
    .requiredOption(
      "--provider <provider>",
      "cli, openai, deepseek, kimi, glm, or custom",
    )
    .option("--model <model>", "Model ID")
    .option("--base-url <url>", "API base URL")
    .option("--api-mode <mode>", "responses or chat_completions")
    .option("--api-key <key>", "API key (prefer --api-key-env)")
    .option(
      "--api-key-env <name>",
      "Read the API key from an environment variable",
    )
    .option("--clear-api-key", "Remove the saved key for this provider")
    .option(
      "--cli-command <command>",
      "CLI executable, such as codex or claude",
    )
    .option("--cli-kind <kind>", "codex or claude")
    .action(
      async (options: {
        provider: string;
        model?: string;
        baseUrl?: string;
        apiMode?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        clearApiKey?: boolean;
        cliCommand?: string;
        cliKind?: string;
      }) => {
        const provider = ProviderIdSchema.parse(options.provider);
        const apiMode = options.apiMode
          ? ApiModeSchema.parse(options.apiMode)
          : undefined;
        const cliKind = options.cliKind
          ? z.enum(["codex", "claude"]).parse(options.cliKind)
          : undefined;
        const apiKeyFromEnv = options.apiKeyEnv
          ? process.env[options.apiKeyEnv]
          : undefined;
        if (options.apiKeyEnv && !apiKeyFromEnv) {
          throw new Error(
            `Environment variable ${options.apiKeyEnv} is empty or missing`,
          );
        }
        const saved = await saveModelProvider({
          provider,
          ...(options.model ? { model: options.model } : {}),
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(apiMode ? { apiMode } : {}),
          ...(options.apiKey || apiKeyFromEnv
            ? { apiKey: options.apiKey ?? apiKeyFromEnv }
            : {}),
          ...(options.clearApiKey ? { clearApiKey: true } : {}),
          ...(options.cliCommand ? { cliCommand: options.cliCommand } : {}),
          ...(cliKind ? { cliKind } : {}),
        });
        const active = sanitizeModelProvider(saved);
        process.stdout.write(
          `Active report model: ${active.provider}${active.model ? ` / ${active.model}` : ""}\n`,
        );
      },
    );

  model
    .command("models")
    .description("List models exposed by the active provider")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const active = await loadActiveModelProvider();
      const models = await discoverProviderModels(active);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
        return;
      }
      if (!models.length) {
        process.stdout.write(
          active.provider === "cli"
            ? "The CLI chooses its own model unless one is configured.\n"
            : "The provider returned no models.\n",
        );
        return;
      }
      for (const name of models) process.stdout.write(`${name}\n`);
    });

  model
    .command("reset")
    .description("Return report generation to automatic local CLI selection")
    .action(async () => {
      await resetModelProvider();
      process.stdout.write("Report model reset to local CLI auto-detection.\n");
    });
}

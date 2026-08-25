import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverProviderModels,
  extractProviderOutput,
  generateWithModelProvider,
  loadActiveModelProvider,
  sanitizeModelProvider,
  saveModelProvider,
} from "../src/infrastructure/model-provider.js";

const temporaryDirectories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "context-ledger-model-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("model provider configuration", () => {
  it("defaults to local CLI auto-detection", async () => {
    const active = await loadActiveModelProvider(await temporaryHome());
    expect(active).toMatchObject({ provider: "cli", model: "" });
  });

  it("stores API credentials locally with owner-only permissions", async () => {
    const home = await temporaryHome();
    const saved = await saveModelProvider(
      {
        provider: "openai",
        model: "gpt-5.6-terra",
        apiKey: "sk-test-secret",
      },
      home,
    );
    const path = join(home, ".local", "model-provider.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("sk-test-secret");
    expect(sanitizeModelProvider(saved)).toMatchObject({
      apiKeyConfigured: true,
      apiKeyHint: "••••cret",
    });
    expect(JSON.stringify(sanitizeModelProvider(saved))).not.toContain(
      "sk-test-secret",
    );
  });

  it("keeps each provider credential when the active provider changes", async () => {
    const home = await temporaryHome();
    await saveModelProvider({ provider: "openai", apiKey: "openai-key" }, home);
    await saveModelProvider({ provider: "kimi", apiKey: "kimi-key" }, home);
    const restored = await saveModelProvider({ provider: "openai" }, home);
    expect(restored.apiKey).toBe("openai-key");
  });

  it("rejects credentials embedded in a custom endpoint URL", async () => {
    await expect(
      saveModelProvider(
        {
          provider: "custom",
          model: "local-model",
          baseUrl: "https://user:password@example.com/v1",
        },
        await temporaryHome(),
      ),
    ).rejects.toThrow("Do not put credentials");
  });
});

describe("model provider API compatibility", () => {
  it("parses Responses and Chat Completions output envelopes", () => {
    expect(
      extractProviderOutput({ output_text: '{"blocks":[]}' }, "responses"),
    ).toBe('{"blocks":[]}');
    expect(
      extractProviderOutput(
        { choices: [{ message: { content: '{"blocks":[]}' } }] },
        "chat_completions",
      ),
    ).toBe('{"blocks":[]}');
  });

  it("discovers and sorts OpenAI-compatible models", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: "model-z" }, { id: "model-a" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const config = await saveModelProvider(
      {
        provider: "custom",
        model: "model-a",
        baseUrl: "http://127.0.0.1:11434/v1/",
      },
      await temporaryHome(),
    );
    await expect(discoverProviderModels(config)).resolves.toEqual([
      "model-a",
      "model-z",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends strict JSON schema through the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output_text: '{"blocks":[]}' }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = await saveModelProvider(
      { provider: "openai", apiKey: "sk-private-test" },
      await temporaryHome(),
    );
    await expect(
      generateWithModelProvider(config, {
        instructions: "Write a report.",
        content: "Input",
        schema: { type: "object" },
      }),
    ).resolves.toBe('{"blocks":[]}');
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers).toMatchObject({
      authorization: "Bearer sk-private-test",
    });
    const body = JSON.parse(String(request.body)) as {
      text: { format: { type: string; strict: boolean } };
    };
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
  });
});

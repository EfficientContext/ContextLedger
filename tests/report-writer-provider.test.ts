import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalHome = process.env.CONTEXT_LEDGER_HOME;
let home = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "context-ledger-writer-test-"));
  process.env.CONTEXT_LEDGER_HOME = home;
  await cp(join(process.cwd(), "prompts"), join(home, "prompts"), {
    recursive: true,
  });
  for (const skill of [
    "research-writing-skill",
    "scientific-toolkit-skill",
    "shuorenhua",
  ]) {
    const target = join(home, ".local", "skills", skill);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "SKILL.md"),
      `# ${skill}\n\nFollow the supplied reporting requirements.\n`,
    );
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.CONTEXT_LEDGER_HOME;
  else process.env.CONTEXT_LEDGER_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe("report writer API provider", () => {
  it("uses the configured OpenAI-compatible endpoint and records the model", async () => {
    vi.resetModules();
    const { saveModelProvider } =
      await import("../src/infrastructure/model-provider.js");
    await saveModelProvider(
      {
        provider: "custom",
        model: "local-report-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiMode: "chat_completions",
      },
      home,
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  blocks: [
                    {
                      sectionKey: "project-demo",
                      content:
                        "- Completed the report rewrite.\n\n#### Risks and next steps\n- No additional risk was recorded.",
                      details: [],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rewriteReportBlocks } =
      await import("../src/application/report-writer.js");
    const result = await rewriteReportBlocks(
      [
        {
          sectionKey: "project-demo",
          projectId: null,
          projectName: "Demo",
          position: 0,
          content: "### Demo\n\n- Supporting draft.",
          details: [],
          claimIds: ["claim-1"],
          missingEvidence: [],
          state: "generated",
        },
      ],
      {
        title: "Demo report",
        from: "2026-08-18T00:00:00.000Z",
        to: "2026-08-25T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
      [],
    );

    expect(result).toMatchObject({
      writer: "custom:local-report-model",
      provider: "custom",
      model: "local-report-model",
      endpoint: "http://127.0.0.1:11434/v1",
      apiMode: "chat_completions",
    });
    expect(result.blocks[0]?.content).toContain("Completed the report rewrite");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const body = JSON.parse(String(request.body)) as {
      model: string;
      response_format: { type: string };
    };
    expect(body).toMatchObject({
      model: "local-report-model",
      response_format: { type: "json_object" },
    });
  });
});

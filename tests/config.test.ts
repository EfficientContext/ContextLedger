import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/infrastructure/config.js";

describe("configuration defaults", () => {
  it("treats an empty INTENTTRACE_REPO as the local default", () => {
    const config = loadConfig({
      ...process.env,
      CONTEXT_LEDGER_HOME: "/tmp/context-ledger-config-test",
      INTENTTRACE_REPO: "",
    });
    expect(config.INTENTTRACE_REPO).toBe(
      join("/tmp/context-ledger-config-test", ".local", "intenttrace"),
    );
  });
});

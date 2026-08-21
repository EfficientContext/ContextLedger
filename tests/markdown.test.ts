// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../public/markdown.js";

describe("renderMarkdown", () => {
  it("renders the report's GFM structures", () => {
    const html = renderMarkdown(`
##### Validation

| Policy | Result |
| --- | ---: |
| MTPO | 0.82 |

Use \`repair_attempts=3\`.

\`\`\`python
print("validated")
\`\`\`

[Artifact](https://example.com/result)
`);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelector("h5")?.textContent).toBe("Validation");
    expect(
      container.querySelector(".markdown-table-wrap table"),
    ).not.toBeNull();
    expect(container.querySelector("thead")).not.toBeNull();
    expect(container.querySelector("tbody")).not.toBeNull();
    expect(container.querySelector("p code")?.textContent).toBe(
      "repair_attempts=3",
    );
    expect(container.querySelector("pre code")?.textContent).toContain(
      "validated",
    );
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });

  it("removes executable HTML from user-edited Markdown", () => {
    const html = renderMarkdown(`
Safe text.

<script>window.compromised = true</script>
<img src="x" onerror="window.compromised = true">
[Unsafe URL](javascript:alert(1))
`);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.textContent).toContain("Safe text.");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("turns report detail tags into local detail links", () => {
    const html = renderMarkdown(
      "- **Validated:** Repair campaign completed. [[detail:work-02-repair-campaign]]",
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const link = container.querySelector(
      'a[href="#detail-work-02-repair-campaign"]',
    );

    expect(link?.textContent).toBe("work-02-repair-campaign");
    expect(link?.hasAttribute("target")).toBe(false);
  });
});

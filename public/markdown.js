import { marked, Renderer } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

const renderer = new Renderer();
const renderTable = renderer.table.bind(renderer);

renderer.table = (token) =>
  `<div class="markdown-table-wrap">${renderTable(token)}</div>`;

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer,
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    const href = node.getAttribute("href") || "";
    if (href.startsWith("#detail-")) {
      node.removeAttribute("target");
      node.removeAttribute("rel");
    } else {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
});

export function renderMarkdown(value) {
  const source = String(value).replace(
    /\[\[detail:([a-z0-9][a-z0-9-]*)\]\]/gu,
    "[$1](#detail-$1)",
  );
  const html = marked.parse(source, {
    gfm: true,
    breaks: false,
    renderer,
  });

  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}

import { renderMarkdown } from "/markdown.js";

const state = {
  reports: [],
  projects: [],
  contexts: [],
  currentContext: null,
  currentReport: null,
  currentDetail: null,
  me: null,
  modelProvider: null,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.message || payload.error || `HTTP ${response.status}`,
    );
  }
  return response.json();
}

function reportRange(report) {
  const timezone = report.timezone || "UTC";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  return `${formatter.format(new Date(report.period_start))} 至 ${formatter.format(new Date(new Date(report.period_end).getTime() - 1))}`;
}

function setDefaultDates() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const format = (value) => value.toISOString().slice(0, 10);
  $("#fromDate").value = format(monday);
  $("#toDate").value = format(sunday);
  $("#syncFromDate").value = format(monday);
  $("#syncToDate").value = format(now);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  document.querySelector('[name="observedAt"]').value = local;
}

async function loadMe() {
  state.me = await api("/api/me");
}

async function loadHealth() {
  try {
    await api("/health");
    $(".status-dot").classList.add("ok");
    $("#healthText").textContent = "PostgreSQL 已连接";
  } catch {
    $("#healthText").textContent = "数据库未连接";
  }
}

async function loadModelProvider() {
  state.modelProvider = await api("/api/model-provider");
  const { active, presets } = state.modelProvider;
  const providerSelect = $("#modelProvider");
  providerSelect.innerHTML = presets
    .map(
      (preset) =>
        `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`,
    )
    .join("");
  providerSelect.value = active.provider;
  $("#modelName").value = active.model || "";
  $("#modelBaseUrl").value = active.baseUrl || "";
  $("#modelApiMode").value = active.apiMode;
  $("#modelCliCommand").value = active.cliCommand || "";
  $("#modelCliKind").value = active.cliKind || "";
  $("#modelApiKey").value = "";
  $("#modelApiKey").placeholder = active.apiKeyConfigured
    ? `已保存 ${active.apiKeyHint}，留空会继续使用`
    : "输入 API key";
  renderModelOptions(
    presets.find((preset) => preset.id === active.provider)?.suggestedModels ||
      [],
  );
  renderModelStatus();
  updateModelFieldVisibility();
}

function renderModelOptions(models) {
  $("#modelOptions").innerHTML = models
    .map((model) => `<option value="${escapeHtml(model)}"></option>`)
    .join("");
}

function renderModelStatus() {
  const active = state.modelProvider?.active;
  if (!active) return;
  const preset = state.modelProvider.presets.find(
    (item) => item.id === active.provider,
  );
  $("#modelStatusTitle").textContent = preset?.label || active.provider;
  $("#modelStatus").innerHTML =
    active.provider === "cli"
      ? `<div><dt>CLI</dt><dd>${escapeHtml(active.cliCommand || "自动检测")}</dd></div>
         <div><dt>登录</dt><dd>使用 CLI 本地会话</dd></div>`
      : `<div><dt>模型</dt><dd>${escapeHtml(active.model)}</dd></div>
         <div><dt>Endpoint</dt><dd>${escapeHtml(active.baseUrl)}</dd></div>
         <div><dt>接口</dt><dd>${escapeHtml(active.apiMode)}</dd></div>
         <div><dt>密钥</dt><dd>${escapeHtml(active.apiKeyHint || "未配置或不需要")}</dd></div>`;
  $("#activeModelSummary").textContent =
    active.provider === "cli"
      ? `报告模型：${preset?.label || "本地 CLI"}，生成时自动选择已登录的 CLI`
      : `报告模型：${preset?.label || active.provider} / ${active.model}`;
}

function updateModelFieldVisibility() {
  const provider = $("#modelProvider").value;
  const isCli = provider === "cli";
  $("#cliFields").classList.toggle("hidden", !isCli);
  $("#modelName").closest("label").classList.toggle("hidden", isCli);
  $("#modelBaseUrl").closest("label").classList.toggle("hidden", isCli);
  $("#modelApiMode").closest("label").classList.toggle("hidden", isCli);
  $("#modelApiKey").closest("label").classList.toggle("hidden", isCli);
  $("#loadModelsButton").classList.toggle("hidden", isCli);
}

function applyProviderPreset() {
  const provider = $("#modelProvider").value;
  const preset = state.modelProvider.presets.find(
    (item) => item.id === provider,
  );
  if (!preset) return;
  const configured = state.modelProvider.configured?.[provider];
  $("#modelName").value = configured?.model || preset.defaultModel;
  $("#modelBaseUrl").value = configured?.baseUrl || preset.baseUrl;
  $("#modelApiMode").value = configured?.apiMode || preset.apiMode;
  $("#modelCliCommand").value = configured?.cliCommand || "";
  $("#modelCliKind").value = configured?.cliKind || "";
  $("#modelApiKey").value = "";
  $("#modelApiKey").placeholder = configured?.apiKeyConfigured
    ? `已保存 ${configured.apiKeyHint}，留空会继续使用`
    : preset.requiresApiKey
      ? "输入 API key"
      : "可选，本地 endpoint 通常不需要";
  renderModelOptions(preset.suggestedModels);
  updateModelFieldVisibility();
}

async function saveModelSettings(showToast = true) {
  const apiKey = $("#modelApiKey").value.trim();
  const cliKind = $("#modelCliKind").value;
  const body = {
    provider: $("#modelProvider").value,
    model: $("#modelName").value.trim(),
    baseUrl: $("#modelBaseUrl").value.trim(),
    apiMode: $("#modelApiMode").value,
    cliCommand: $("#modelCliCommand").value.trim(),
    ...(cliKind ? { cliKind } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  await api("/api/model-provider", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  await loadModelProvider();
  if (showToast) toast("报告模型已保存");
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  $("#projectCount").textContent = state.projects.length;
  const list = $("#projectsList");
  const select = $("#ingestProject");
  const projectOptions = state.projects
    .map(
      (project) =>
        `<option value="${project.id}">${escapeHtml(project.name)}</option>`,
    )
    .join("");
  select.innerHTML = '<option value="">自动分类</option>' + projectOptions;
  $("#syncProject").innerHTML =
    '<option value="">自动分类</option>' +
    state.projects
      .map(
        (project) =>
          `<option value="${escapeHtml(project.slug)}">${escapeHtml(project.name)}</option>`,
      )
      .join("");
  $("#contextProjectFilter").innerHTML =
    '<option value="">全部项目</option>' + projectOptions;
  if (!state.projects.length) {
    list.className = "project-cards empty";
    list.textContent = "还没有项目";
    return;
  }
  list.className = "project-cards";
  list.innerHTML = state.projects
    .map(
      (project) => `
    <article class="project-card">
      <h2>${escapeHtml(project.name)}</h2>
      <p>${escapeHtml(project.description || "暂无说明")}</p>
      <small>${project.event_count} 条 context · ${project.claim_count} 条结论</small>
    </article>`,
    )
    .join("");
}

async function loadContexts() {
  const params = new URLSearchParams({ limit: "200" });
  const projectId = $("#contextProjectFilter")?.value;
  const source = $("#contextSourceFilter")?.value;
  if (projectId) params.set("projectId", projectId);
  if (source) params.set("source", source);
  state.contexts = await api(`/api/context?${params}`);
  $("#contextCount").textContent = state.contexts.length;
  const list = $("#contextsList");
  if (!state.contexts.length) {
    list.className = "context-list empty";
    list.textContent = "这个筛选范围内还没有 Context。";
    return;
  }
  list.className = "context-list";
  list.innerHTML = state.contexts
    .map(
      (item) => `
      <button class="context-item ${state.currentContext?.id === item.id ? "active" : ""}" data-context-id="${item.id}">
        <div class="context-item-head">
          <span class="source-badge ${item.agentSource || item.source}">${sourceLabel(item.source, item.agentSource)}</span>
          <time>${formatObservedAt(item.observedAt)}</time>
        </div>
        <strong>${escapeHtml(item.title || "Untitled context")}</strong>
        <p>${escapeHtml(item.summary || "No visible summary")}</p>
        <small>${escapeHtml(item.projectName || "未分类")} · ${item.validationCount} 项验证 · ${item.intentNodeCount} 个 graph node</small>
      </button>`,
    )
    .join("");
  $$("[data-context-id]").forEach((button) =>
    button.addEventListener("click", () =>
      openContext(button.dataset.contextId),
    ),
  );
}

async function openContext(eventId) {
  state.currentContext = await api(`/api/context/${eventId}`);
  renderContextDetail();
  await loadContexts();
}

function renderContextDetail() {
  const root = $("#contextDetail");
  const item = state.currentContext;
  if (!item) {
    root.className = "editor-empty";
    root.textContent =
      "选择一条 Context，查看 IntentTrace graph、claims、验证和参考文件。";
    return;
  }
  const context = item.payload?.contextLedger || {};
  const graph = context.intentGraph || { nodes: [], edges: [] };
  const canEdit = item.actorUserId === state.me?.userId;
  root.className = "";
  root.innerHTML = `
    <div class="context-detail-head">
      <div>
        <div class="context-detail-meta">
          <span class="source-badge ${item.agentSource || item.source}">${sourceLabel(item.source, item.agentSource)}</span>
          <span>${escapeHtml(item.projectName || "未分类")}</span>
          <span>${formatObservedAt(item.observedAt)}</span>
          <span>${visibilityLabel(item.visibility)}</span>
          <span>revision ${item.revisionCount || 0}</span>
        </div>
        <h2>${escapeHtml(item.title || "Untitled context")}</h2>
      </div>
      ${canEdit ? '<button class="secondary" id="editContextButton">编辑 Context</button>' : ""}
    </div>

    ${context.userNote ? `<div class="user-note"><strong>用户修正</strong><p>${escapeHtml(context.userNote)}</p></div>` : ""}
    <p class="context-narrative">${escapeHtml(context.narrative || item.text || "")}</p>

    <section class="context-section">
      <div class="section-title-row">
        <h3>IntentTrace graph</h3>
        <span>${graph.nodes?.length || 0} nodes · ${graph.edges?.length || 0} edges</span>
      </div>
      ${renderIntentGraph(graph)}
    </section>

    ${renderContextListSection("具体改动", context.details)}
    ${renderContextListSection("设计决策", context.decisions)}
    ${renderValidationSection(context.validations)}
    ${renderClaimsSection(item.claims)}
    ${renderContextListSection("限制", context.boundaries)}
    ${renderMissingMaterialsSection(context.missingMaterials)}
    ${renderArtifactsSection(item.artifacts, context.referencePaths)}
    ${renderRevisionSection(item.revisions)}
  `;
  $("#editContextButton")?.addEventListener("click", editContext);
}

function renderContextListSection(title, values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  return `
    <section class="context-section">
      <h3>${escapeHtml(title)}</h3>
      <ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>
    </section>`;
}

function renderValidationSection(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  return `
    <section class="context-section">
      <h3>Validation</h3>
      <div class="validation-cards">
        ${values
          .map(
            (row) => `
          <article>
            <code>${escapeHtml(row.command)}</code>
            <strong>${escapeHtml(row.result)}</strong>
            <p>${escapeHtml(row.meaning)}</p>
          </article>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderClaimsSection(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  return `
    <section class="context-section">
      <h3>Claims</h3>
      <div class="claim-list">
        ${values
          .map(
            (claim) => `
          <article>
            <span>${escapeHtml(claim.kind)} · ${escapeHtml(claim.status)} · ${(claim.confidence * 100).toFixed(0)}%</span>
            <p>${escapeHtml(claim.summary)}</p>
          </article>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderMissingMaterialsSection(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  return `
    <section class="context-section">
      <h3>建议补充</h3>
      <div class="missing-material-list">
        ${values
          .map(
            (item) => `
          <article class="${escapeHtml(item.severity || "suggested")}">
            <span>${escapeHtml(item.severity === "blocking" ? "报告前最好补上" : "有的话更完整")}</span>
            <p>${escapeHtml(item.label)}</p>
          </article>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderArtifactsSection(artifacts, references) {
  const collected = [
    ...(Array.isArray(artifacts)
      ? artifacts.map((artifact) => ({
          label: artifact.title || artifact.uri || artifact.kind,
          uri: artifact.uri,
        }))
      : []),
    ...(Array.isArray(references)
      ? references.map((reference) => ({ label: reference, uri: null }))
      : []),
  ];
  const values = [
    ...new Map(collected.map((value) => [value.label, value])).values(),
  ];
  if (!values.length) return "";
  return `
    <section class="context-section">
      <h3>Artifacts and references</h3>
      <ul class="reference-list">
        ${values
          .map((value) =>
            value.uri && /^https?:/u.test(value.uri)
              ? `<li><a href="${escapeHtml(value.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value.label)}</a></li>`
              : `<li><code>${escapeHtml(value.label)}</code></li>`,
          )
          .join("")}
      </ul>
    </section>`;
}

function renderRevisionSection(revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return "";
  return `
    <section class="context-section">
      <h3>修改记录</h3>
      <div class="revision-list">
        ${revisions
          .map(
            (revision) => `
          <article>
            <strong>revision ${revision.revision}</strong>
            <span>${formatObservedAt(revision.createdAt)}</span>
          </article>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderIntentGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!nodes.length) {
    return '<div class="graph-empty">这条记录没有 IntentTrace graph，可能是手动 capture。</div>';
  }
  const stage = {
    request: 0,
    issue: 1,
    work: 2,
    decision: 3,
    result: 3,
    blocker: 3,
    follow_up: 4,
  };
  const lanes = new Map();
  const positions = nodes.map((node, index) => {
    const column = stage[node.kind] ?? Math.min(index, 4);
    const row = lanes.get(column) || 0;
    lanes.set(column, row + 1);
    return {
      ...node,
      index,
      x: 28 + column * 190,
      y: 35 + row * 112,
    };
  });
  const byTitle = new Map(positions.map((node) => [node.title, node]));
  const width = Math.max(640, ...positions.map((node) => node.x + 170));
  const height = Math.max(210, ...positions.map((node) => node.y + 82));
  return `
    <div class="intent-graph-wrap">
      <svg class="intent-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="IntentTrace graph">
        <defs>
          <marker id="graphArrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z"></path>
          </marker>
        </defs>
        ${edges
          .map((edge) => {
            const source = byTitle.get(edge.source);
            const target = byTitle.get(edge.target);
            if (!source || !target) return "";
            return `<path class="graph-edge" d="M${source.x + 150},${source.y + 34} C${source.x + 170},${source.y + 34} ${target.x - 20},${target.y + 34} ${target.x},${target.y + 34}" marker-end="url(#graphArrow)"><title>${escapeHtml(edge.kind)} · ${escapeHtml(edge.provenance)}</title></path>`;
          })
          .join("")}
        ${positions
          .map(
            (node) => `
          <g class="graph-node ${escapeHtml(node.kind)}" transform="translate(${node.x},${node.y})">
            <rect width="150" height="68" rx="10"></rect>
            <text class="graph-node-kind" x="12" y="18">${escapeHtml(node.kind)}</text>
            ${svgText(node.title, 12, 37, 20)}
            <title>${escapeHtml((node.claims || []).join(" · "))}</title>
          </g>`,
          )
          .join("")}
      </svg>
    </div>`;
}

function svgText(value, x, y, maxChars) {
  const words = String(value || "").split(/\s+/u);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines
    .slice(0, 2)
    .map(
      (text, index) =>
        `<text class="graph-node-title" x="${x}" y="${y + index * 16}">${escapeHtml(text)}</text>`,
    )
    .join("");
}

function editContext() {
  const item = state.currentContext;
  const context = item.payload?.contextLedger || {};
  const root = $("#contextDetail");
  root.innerHTML = `
    <form id="contextEditForm" class="context-edit-form">
      <div class="context-detail-head">
        <div><p class="eyebrow">Edit context revision</p><h2>${escapeHtml(item.title || "Untitled context")}</h2></div>
        <button type="button" class="secondary" id="cancelContextEdit">取消</button>
      </div>
      <label>标题<input name="title" value="${escapeHtml(item.title || "")}" /></label>
      <label>项目<select name="projectId">
        <option value="">未分类</option>
        ${state.projects
          .map(
            (project) =>
              `<option value="${project.id}" ${project.id === item.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`,
          )
          .join("")}
      </select></label>
      <label>可见范围<select name="visibility">
        ${["private", "project", "organization"]
          .map(
            (value) =>
              `<option value="${value}" ${value === item.visibility ? "selected" : ""}>${visibilityLabel(value)}</option>`,
          )
          .join("")}
      </select></label>
      <label>给下一份报告的修正说明<textarea name="userNote" rows="5" placeholder="例如：这里的 23 passed 只验证实现正确，不代表性能提升。">${escapeHtml(context.userNote || "")}</textarea><small>新生成的报告会优先读取这段说明。</small></label>
      <label>页面正文<textarea name="text" rows="10">${escapeHtml(item.text || "")}</textarea></label>
      <div class="form-submit-row"><button class="primary" type="submit">保存修改</button></div>
    </form>`;
  $("#cancelContextEdit").addEventListener("click", renderContextDetail);
  $("#contextEditForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api(`/api/context/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: form.get("title") || null,
        text: form.get("text") || null,
        userNote: form.get("userNote") || null,
        projectId: form.get("projectId") || null,
        visibility: form.get("visibility"),
      }),
    });
    toast("Context revision 已保存");
    await openContext(item.id);
    await Promise.all([loadProjects(), loadReports()]);
  });
}

function sourceLabel(source, agentSource) {
  if (source === "intenttrace" && agentSource) {
    return `IntentTrace · ${agentSource.toLowerCase().includes("claude") ? "Claude Code" : "Codex"}`;
  }
  return (
    {
      intenttrace: "IntentTrace",
      codex: "Codex",
      claude: "Claude",
      manual: "Manual",
      mcp: "MCP",
      experiment: "Experiment",
      git: "Git",
      iwiki: "iWiki",
    }[source] || source
  );
}

function visibilityLabel(value) {
  return (
    {
      private: "仅自己",
      project: "团队共享",
      organization: "组织共享",
    }[value] || value
  );
}

function formatObservedAt(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function loadReports() {
  state.reports = await api("/api/reports");
  $("#reportCount").textContent = state.reports.length;
  const list = $("#reportsList");
  if (!state.reports.length) {
    list.className = "item-list empty";
    list.textContent = "还没有报告";
    return;
  }
  list.className = "item-list";
  list.innerHTML = state.reports
    .map(
      (report) => `
    <div class="report-item ${state.currentReport?.id === report.id ? "active" : ""}">
      <button class="report-open" data-report-id="${report.id}">
        <strong>${escapeHtml(report.title)}</strong>
        <small>${reportRange(report)}</small>
        <small>${report.generation_metadata?.scope === "tenant" ? "团队共享" : "仅自己"}</small>
        ${report.needs_evidence_count ? `<small class="warning">${report.needs_evidence_count} 个项目待补充证据</small>` : ""}
      </button>
      ${report.can_delete ? `<button class="report-delete" data-delete-report="${report.id}" aria-label="删除 ${escapeHtml(report.title)}" title="删除报告">删除</button>` : ""}
    </div>`,
    )
    .join("");
  $$("[data-report-id]").forEach((button) =>
    button.addEventListener("click", () => openReport(button.dataset.reportId)),
  );
  $$("[data-delete-report]").forEach((button) =>
    button.addEventListener("click", () => {
      const report = state.reports.find(
        (item) => item.id === button.dataset.deleteReport,
      );
      if (report) deleteReport(report);
    }),
  );
}

async function deleteReport(report) {
  const confirmed = window.confirm(
    `确定删除“${report.title}”吗？删除后无法恢复。`,
  );
  if (!confirmed) return;

  await api(`/api/reports/${report.id}`, { method: "DELETE" });
  if (state.currentReport?.id === report.id) {
    state.currentReport = null;
    state.currentDetail = null;
    if ($("#detailModal").open) $("#detailModal").close();
    $("#editorTitle").textContent = "报告编辑器";
    $("#editorMeta").textContent = "选择或生成一份报告";
    $("#copyButton").classList.add("hidden");
    $("#reportEditor").className = "editor-empty";
    $("#reportEditor").textContent = "报告正文会显示在这里。";
  }
  await loadReports();
  toast("报告已删除");
}

async function openReport(reportId) {
  state.currentReport = await api(`/api/reports/${reportId}`);
  state.currentDetail = null;
  $("#editorTitle").textContent = state.currentReport.title;
  const writerMetadata = state.currentReport.generation_metadata || {};
  const writerLabel = writerMetadata.model
    ? `${writerMetadata.provider} / ${writerMetadata.model}`
    : writerMetadata.writer || "unknown writer";
  $("#editorMeta").textContent =
    `${reportRange(state.currentReport)} · ${state.currentReport.timezone} · ${state.currentReport.generation_metadata?.scope === "tenant" ? "团队共享" : "仅自己"} · ${writerLabel} · revision ${state.currentReport.revision}`;
  $("#copyButton").classList.remove("hidden");
  renderEditor();
  loadReports();
}

function renderEditor() {
  const editor = $("#reportEditor");
  if (!state.currentReport) return;
  if (!state.currentReport.blocks.length) {
    editor.className = "editor-empty";
    editor.textContent = "这个时间范围内还没有可写入报告的结论。";
    return;
  }
  editor.className = "";
  editor.innerHTML = state.currentReport.blocks
    .map(
      (block) => `
    <section class="report-block" data-block-id="${block.id}">
      <div class="block-toolbar">
        <span class="block-state ${block.state}">${stateLabel(block.state)}</span>
        <div class="block-actions">
          <button data-edit-block="${block.id}">编辑</button>
          <button data-lock-block="${block.id}">编辑并锁定</button>
        </div>
      </div>
      <div class="block-content">${renderMarkdown(block.editedContent || block.generatedContent)}</div>
      ${block.missingEvidence?.length ? `<ul class="evidence-list">${block.missingEvidence.map((item) => `<li>${escapeHtml(item.label)}</li>`).join("")}</ul>` : ""}
    </section>`,
    )
    .join("");
  $$("[data-edit-block]").forEach((button) =>
    button.addEventListener("click", () =>
      editBlock(button.dataset.editBlock, false),
    ),
  );
  $$("[data-lock-block]").forEach((button) =>
    button.addEventListener("click", () =>
      editBlock(button.dataset.lockBlock, true),
    ),
  );
  $$('.block-content a[href^="#detail-"]').forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openDetail(link.getAttribute("href").slice("#detail-".length));
    }),
  );
}

async function openDetail(tag) {
  state.currentDetail = await api(
    `/api/reports/${state.currentReport.id}/details/${encodeURIComponent(tag)}`,
  );
  const modal = $("#detailModal");
  $("#detailTag").textContent = state.currentDetail.tag;
  $("#detailTitle").textContent = state.currentDetail.title;
  $("#detailContent").innerHTML = renderMarkdown(state.currentDetail.content);
  if (!modal.open) modal.showModal();
}

function editDetail(lockOnSave) {
  const detail = state.currentDetail;
  const content = $("#detailContent");
  content.innerHTML = `
    <textarea class="block-edit">${escapeHtml(detail.editedContent || detail.generatedContent)}</textarea>
    <div class="block-actions">
      <button data-detail-cancel>取消</button>
      <button class="primary" data-detail-save>保存</button>
    </div>`;
  content
    .querySelector("[data-detail-cancel]")
    .addEventListener("click", () => openDetail(detail.tag));
  content
    .querySelector("[data-detail-save]")
    .addEventListener("click", async () => {
      const value = content.querySelector("textarea").value;
      await api(`/api/report-details/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: value, locked: lockOnSave }),
      });
      toast("细节已保存");
      await openReport(state.currentReport.id);
      await openDetail(detail.tag);
    });
}

function editBlock(blockId, lockOnSave) {
  const block = state.currentReport.blocks.find((item) => item.id === blockId);
  const section = document.querySelector(`[data-block-id="${blockId}"]`);
  section.innerHTML = `
    <div class="block-toolbar"><strong>${lockOnSave ? "编辑后锁定" : "编辑报告块"}</strong></div>
    <textarea class="block-edit">${escapeHtml(block.editedContent || block.generatedContent)}</textarea>
    <div class="block-actions"><button data-cancel>取消</button><button class="primary" data-save>保存</button></div>`;
  section
    .querySelector("[data-cancel]")
    .addEventListener("click", renderEditor);
  section.querySelector("[data-save]").addEventListener("click", async () => {
    const content = section.querySelector("textarea").value;
    await api(`/api/report-blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ content, locked: lockOnSave }),
    });
    toast("已保存新 revision");
    await openReport(state.currentReport.id);
  });
}

function stateLabel(value) {
  return (
    {
      generated: "系统生成",
      user_edited: "用户已改",
      user_confirmed: "用户确认",
      needs_evidence: "待补证据",
      stale: "内容过期",
      locked: "已锁定",
    }[value] || value
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
}

$("#generateButton").addEventListener("click", async () => {
  const fromDate = $("#fromDate").value;
  const toDate = $("#toDate").value;
  if (!fromDate || !toDate) return toast("请先选择日期");
  const result = await api("/api/reports/generate", {
    method: "POST",
    body: JSON.stringify({
      fromDate,
      toDate,
      timezone: $("#timezone").value,
      scope: $("#reportScope").value,
    }),
  });
  toast("报告已生成");
  await loadReports();
  await openReport(result.id);
});

$("#modelProvider").addEventListener("change", applyProviderPreset);

$("#modelForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveModelSettings();
  } catch (error) {
    toast(error instanceof Error ? error.message : "模型设置保存失败");
  }
});

$("#loadModelsButton").addEventListener("click", async () => {
  const button = $("#loadModelsButton");
  button.disabled = true;
  try {
    await saveModelSettings(false);
    const result = await api("/api/model-provider/models", { method: "POST" });
    renderModelOptions(result.models);
    toast(`读取到 ${result.models.length} 个模型`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "读取模型列表失败");
  } finally {
    button.disabled = false;
  }
});

$("#resetModelButton").addEventListener("click", async () => {
  await api("/api/model-provider", { method: "DELETE" });
  await loadModelProvider();
  toast("已恢复 CLI 自动检测");
});

$("#syncButton").addEventListener("click", async () => {
  const fromDate = $("#syncFromDate").value;
  const toDate = $("#syncToDate").value;
  if (!fromDate || !toDate) return toast("请先选择同步日期");

  const button = $("#syncButton");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在整理 session...";
  try {
    const result = await api("/api/context/sync", {
      method: "POST",
      body: JSON.stringify({
        source: $("#syncSource").value,
        fromDate,
        toDate,
        timezone: $("#timezone").value,
        projectSlug: $("#syncProject").value || undefined,
        visibility: $("#syncVisibility").value,
      }),
    });
    await Promise.all([loadProjects(), loadReports()]);
    await loadContexts();
    const failed = result.failed?.length
      ? `，${result.failed.length} 条没能解析`
      : "";
    toast(
      `同步完成：新增 ${result.imported} 条，跳过 ${result.duplicates} 条重复${failed}`,
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : "同步失败");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#contextProjectFilter").addEventListener("change", loadContexts);
$("#contextSourceFilter").addEventListener("change", loadContexts);

$("#copyButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.currentReport.markdown);
  toast("Markdown 已复制");
});

$("#detailClose").addEventListener("click", () => $("#detailModal").close());
$("#detailEdit").addEventListener("click", () => editDetail(false));
$("#detailLock").addEventListener("click", () => editDetail(true));

$("#projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const aliases = [];
  if (form.get("keyword"))
    aliases.push({ type: "keyword", value: form.get("keyword") });
  if (form.get("repo")) aliases.push({ type: "repo", value: form.get("repo") });
  await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: form.get("name"),
      slug: form.get("slug"),
      description: form.get("description"),
      aliases,
    }),
  });
  event.currentTarget.reset();
  toast("项目已创建");
  await loadProjects();
});

$("#ingestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const claim = form.get("claim");
  const input = {
    source: form.get("source"),
    sourceRef: form.get("sourceRef"),
    observedAt: new Date(form.get("observedAt")).toISOString(),
    title: form.get("title"),
    text: form.get("text"),
    projectId: form.get("projectId") || undefined,
    visibility: form.get("visibility"),
    claims: claim
      ? [
          {
            kind: "work",
            status: "stated",
            subject: form.get("title"),
            predicate: "completed",
            summary: claim,
            confidence: 0.9,
          },
        ]
      : [],
  };
  const result = await api("/api/context/ingest", {
    method: "POST",
    body: JSON.stringify(input),
  });
  toast(result.inserted ? "Context 已写入" : "这条 Context 已存在");
  event.currentTarget.reset();
  setDefaultDates();
  await loadProjects();
  await loadContexts();
});

$$(".nav-item").forEach((button) =>
  button.addEventListener("click", () => {
    $$(".nav-item").forEach((item) =>
      item.classList.toggle("active", item === button),
    );
    $$(".view").forEach((view) =>
      view.classList.toggle("active", view.id === `${button.dataset.view}View`),
    );
    $("#viewTitle").textContent = {
      reports: "报告",
      models: "模型",
      contexts: "Context",
      projects: "项目",
      ingest: "写入 Context",
    }[button.dataset.view];
  }),
);

$("#refreshButton").addEventListener("click", async () => {
  await Promise.all([
    loadMe(),
    loadHealth(),
    loadProjects(),
    loadReports(),
    loadModelProvider(),
  ]);
  await loadContexts();
  toast("已刷新");
});

setDefaultDates();
await Promise.all([
  loadMe(),
  loadHealth(),
  loadProjects(),
  loadReports(),
  loadModelProvider(),
]);
await loadContexts();

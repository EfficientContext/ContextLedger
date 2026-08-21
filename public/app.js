import { renderMarkdown } from "/markdown.js";

const state = {
  reports: [],
  projects: [],
  currentReport: null,
  currentDetail: null,
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
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  document.querySelector('[name="observedAt"]').value = local;
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

async function loadProjects() {
  state.projects = await api("/api/projects");
  $("#projectCount").textContent = state.projects.length;
  const list = $("#projectsList");
  const select = $("#ingestProject");
  select.innerHTML =
    '<option value="">自动分类</option>' +
    state.projects
      .map(
        (project) =>
          `<option value="${project.id}">${escapeHtml(project.name)}</option>`,
      )
      .join("");
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
  $("#editorMeta").textContent =
    `${reportRange(state.currentReport)} · ${state.currentReport.timezone} · ${state.currentReport.generation_metadata?.scope === "tenant" ? "团队共享" : "仅自己"} · revision ${state.currentReport.revision}`;
  $("#copyButton").classList.remove("hidden");
  renderEditor();
  loadReports();
}

function renderEditor() {
  const editor = $("#reportEditor");
  if (!state.currentReport) return;
  if (!state.currentReport.blocks.length) {
    editor.className = "editor-empty";
    editor.textContent = "这个时间范围内还没有可写入周报的结论。";
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
      reports: "周报",
      projects: "项目",
      ingest: "写入 Context",
    }[button.dataset.view];
  }),
);

$("#refreshButton").addEventListener("click", async () => {
  await Promise.all([loadHealth(), loadProjects(), loadReports()]);
  toast("已刷新");
});

setDefaultDates();
await Promise.all([loadHealth(), loadProjects(), loadReports()]);

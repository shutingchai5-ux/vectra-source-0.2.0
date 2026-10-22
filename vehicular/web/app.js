"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let currentState = { nodes: [], tasks: [], events: [] };
let activeView = "workspace";
let stateFetching = false;
let dialogTaskId = null;
let reportOptionIds = "";
let lastLoadedReportId = null;
let lastEventsFingerprint = "";
let lastDialogFingerprint = "";
const experimentResponses = new Map();
const pollingTasks = new Set();

const experiments = [
  { id: "tamper_message", title: "消息篡改", category: "INTEGRITY", symbol: "≠", description: "修改已签署消息的接收者字段，检验接收端能否通过数字签名识别内容变化。" },
  { id: "replay", title: "重放消息", category: "FRESHNESS", symbol: "↺", description: "重复提交已经处理过的消息，检验消息唯一性与时效性保护。" },
  { id: "impersonation", title: "身份冒用", category: "IDENTITY", symbol: "◎", description: "使用不匹配的凭据声明车辆身份，检验身份绑定与签名验证。" },
  { id: "unauthorized", title: "越权访问", category: "AUTHORIZATION", symbol: "▣", description: "使用合法协调身份请求未批准的 raw_speed 指标，检验已认证请求的任务授权范围。" },
  { id: "tamper_report", title: "报告篡改", category: "PROVENANCE", symbol: "◇", description: "修改已签署报告中的正文摘要，检验数字签名能否检测内容改动。" },
  { id: "dropout", title: "参与节点掉线", category: "AVAILABILITY", symbol: "⌁", description: "模拟必要参与方退出，观察聚合协议的失败方式与明确反馈。" },
  { id: "ciphertext", title: "密文篡改检测", category: "AUTHENTICATED ENCRYPTION", symbol: "⌘", description: "翻转隔离对象密文中的一个字节，检验 AES-GCM 认证解密是否拒绝被修改的载荷。" },
];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function formatTime(value, date = false) {
  if (!value) return "时间未提供";
  const numeric = typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : null;
  const parsed = new Date(numeric != null && numeric < 1e12 ? numeric * 1000 : value);
  if (!Number.isFinite(parsed.getTime())) return String(value);
  return parsed.toLocaleString("zh-CN", { ...(date ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function publicDetails(value, depth = 0) {
  if (depth > 7) return "…";
  if (Array.isArray(value)) return value.map((item) => publicDetails(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /^(private_?inputs?|individual_?speeds?|raw_?speeds?|secret_?key|shares|plaintext|inputs)$/i.test(key) ? "[私有数据不公开]" : publicDetails(child, depth + 1)]));
  }
  return value;
}

function readable(value) {
  return typeof value === "string" ? value : JSON.stringify(publicDetails(value), null, 2);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.detail ?? data?.message ?? data?.error ?? `请求失败（HTTP ${response.status}）`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (data === null) throw new Error("服务端没有返回有效 JSON。");
  return data;
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  $("#toast-stack").append(element);
  setTimeout(() => element.remove(), 6000);
}

function setBusy(button, busy, message = "正在执行…") {
  if (busy) { button.dataset.originalContent = button.innerHTML; button.textContent = message; button.disabled = true; }
  else { button.innerHTML = button.dataset.originalContent ?? button.innerHTML; button.disabled = false; }
}

function changeView(view) {
  if (!["workspace", "evidence", "verification", "lab"].includes(view)) view = "workspace";
  activeView = view;
  $$(".view").forEach((element) => { const match = element.id === `view-${view}`; element.hidden = !match; element.classList.toggle("active", match); });
  $$(".nav-item").forEach((element) => { element.classList.toggle("active", element.dataset.view === view); if (element.dataset.view === view) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current"); });
  $("#view-label").textContent = { workspace: "协作工作台", evidence: "证据与审计", verification: "结果验证", lab: "安全实验室" }[view];
  history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function statusInfo(status) {
  const normalized = String(status ?? "unknown").toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(normalized)) return ["已完成", "completed"];
  if (["failed", "error", "rejected", "blocked"].includes(normalized)) return ["未完成", "failed"];
  if (["running", "processing", "in_progress"].includes(normalized)) return ["执行中", "running"];
  if (["pending", "queued", "created"].includes(normalized)) return ["等待执行", "queued"];
  return ["状态未知", "queued"];
}

function getReport(task) { return task?.report ?? task?.signed_report ?? null; }

function getAggregate(task) {
  const report = getReport(task);
  const candidates = [task?.result, task?.result?.aggregate, task?.result?.data, task?.result?.statistics, report?.payload?.result, report?.payload, report?.data?.result, report?.data, report?.report?.result, report?.report, report?.result, report?.body];
  for (const value of candidates) {
    if (!value || typeof value !== "object") continue;
    const mean = value.mean_speed_kmh ?? value.mean_speed ?? value.average_speed_kmh ?? value.average_speed ?? value.mean_kmh ?? value.mean;
    if (mean != null && Number.isFinite(Number(mean))) return { ...value, mean: Number(mean), road: value.road ?? "S101", participants: value.participants ?? value.participant_count ?? value.count, window: value.window_seconds ?? value.window };
  }
  return null;
}

function sortedTasks() { return [...(currentState.tasks ?? [])].sort((a, b) => typeof a.created_at === "number" && typeof b.created_at === "number" ? b.created_at - a.created_at : String(b.created_at ?? b.id).localeCompare(String(a.created_at ?? a.id))); }

function renderStats() {
  const nodes = currentState.nodes ?? [];
  const enabled = nodes.filter((node) => node.enabled !== false).length;
  $("#node-count").textContent = String(enabled);
  $("#node-caption").textContent = `已启用 ${enabled} / ${nodes.length} 个登记身份`;
  const tasks = currentState.tasks ?? [];
  const completed = tasks.filter((task) => statusInfo(task.status)[1] === "completed").length;
  $("#task-count").textContent = String(tasks.length);
  $("#task-caption").textContent = `${completed} 次完成 · ${tasks.filter((task) => statusInfo(task.status)[1] === "running").length} 次执行中`;
  const audit = currentState.audit;
  $("#audit-status").textContent = audit ? audit.valid === true ? "完整" : audit.valid === false ? "异常" : "待验证" : "待验证";
  $("#audit-status").className = `stat-value audit-value ${audit?.valid === true ? "good" : audit?.valid === false ? "bad" : ""}`;
  $("#audit-caption").textContent = audit ? `${audit.count ?? currentState.events?.length ?? 0} 条记录 · ${audit.valid === true ? "链校验通过" : audit.reason ?? "等待校验"}` : "等待完整性校验";
  const llm = currentState.mode === "llm";
  $("#execution-mode").textContent = llm ? "双智能体" : "确定性演示";
  $("#mode-badge").textContent = llm ? "外部模型 · 双智能体协作" : "DEMO · 确定性工具编排";
  $("#mode-caption").textContent = llm ? currentState.llm?.model ?? "外部模型已配置" : "真实安全工具 · 无模型调用";
  $("#mode-explanation").textContent = llm ? `规划与解释智能体使用 ${currentState.llm?.model ?? "外部模型"}；密码学、授权与验证由服务端工具执行。` : "演示模式使用确定性任务编排与真实密码学工具，不调用大语言模型。配置外部模型后启用规划与解释智能体。";
  const eventCount = currentState.events?.length ?? 0;
  $("#event-nav-count").textContent = String(eventCount);
  $("#evidence-count").textContent = currentState.audit?.count > eventCount ? `最近 ${eventCount} 条 / 共 ${currentState.audit.count} 条事件` : `${eventCount} 条事件`;
}

function renderArchitecture() {
  const nodes = currentState.nodes ?? [];
  let vehicles = nodes.filter((node) => /vehicle|车辆|participant/i.test(`${node.id} ${node.role}`));
  if (vehicles.length === 0) vehicles = nodes.slice(0, 3);
  $("#vehicle-nodes").innerHTML = vehicles.length ? vehicles.slice(0, 3).map((node) => `<div class="vehicle-node" title="${escapeHTML(`身份：${node.id}；证书指纹：${node.certificate_fingerprint ?? "未提供"}；有效期：${node.expires_at ?? "未提供"}`)}"><span class="vehicle-symbol">▱</span><div><strong>${escapeHTML(node.id)}</strong><small>${node.enabled === false ? "节点未启用" : "证书已注册"}</small></div><span class="node-status${node.enabled === false ? " off" : ""}"></span></div>`).join("") : '<div class="architecture-empty">暂无参与节点</div>';
  $("#protocol-name").textContent = currentState.protocol?.name ?? "安全多方计算";
  $("#transport-name").textContent = currentState.protocol?.transport ?? "认证加密传输";
  const threshold = currentState.protocol?.threshold;
  $("#threshold-label").textContent = threshold != null ? `协议阈值：${typeof threshold === "object" ? JSON.stringify(threshold) : threshold}` : "协议参数未提供";
  $("#privacy-caption").textContent = currentState.protocol?.privacy ?? "车辆原始输入保留在参与节点，仅通过协议协作计算。";
}

function renderTasks() {
  const tasks = sortedTasks();
  $("#task-list").innerHTML = tasks.length ? tasks.slice(0, 20).map((task) => {
    const [label, className] = statusInfo(task.status);
    return `<div class="task-row" role="button" tabindex="0" data-task-id="${escapeHTML(task.id)}" aria-label="查看任务 ${escapeHTML(task.id)}"><div class="task-type-icon">${getAggregate(task) ? "Σ" : "↗"}</div><div class="task-row-content"><div class="task-row-title">${escapeHTML(task.request ?? task.description ?? "协作任务")}</div><div class="task-row-meta"><span>${escapeHTML(formatTime(task.created_at))}</span><span>${escapeHTML(task.id)}</span></div></div><span class="status-tag ${className}">${label}</span><span class="row-arrow">↗</span></div>`;
  }).join("") : '<div class="empty-state"><span>↗</span><strong>从一次安全协作开始</strong><p>发起任务后，查看智能体步骤、执行证据与最终报告。</p></div>';
  $("#tasks-updated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  if (dialogTaskId && $("#task-dialog").open) renderTaskDetail(currentState.tasks.find((task) => task.id === dialogTaskId));
}

function renderResults() {
  const tasks = sortedTasks().filter((task) => getAggregate(task) && statusInfo(task.status)[1] === "completed");
  if (!tasks.length) {
    $("#latest-result").innerHTML = '<div class="empty-state compact"><span>Σ</span><strong>还没有公开统计结果</strong><p>联合统计完成后展示道路平均速度。</p></div>';
    $("#result-chart").innerHTML = "";
    return;
  }
  const latest = tasks[0];
  const aggregate = getAggregate(latest);
  const participantText = Array.isArray(aggregate.participants) ? aggregate.participants.length : aggregate.participants;
  $("#latest-result").innerHTML = `<div class="aggregate-label">${escapeHTML(aggregate.road)} 路段 · ${aggregate.sample_source === "local_simulated_vehicles" ? "模拟车辆" : ""}平均速度</div><div class="aggregate-value">${aggregate.mean.toFixed(2)}<small>km/h</small></div><div class="aggregate-meta">${participantText != null ? `<span>${escapeHTML(participantText)} 个参与节点</span>` : ""}${aggregate.window != null ? `<span>${escapeHTML(aggregate.window)} 秒窗口</span>` : ""}<span>${escapeHTML(formatTime(latest.created_at))}</span></div>`;
  const samples = tasks.slice(0, 12).reverse().map((task) => getAggregate(task).mean);
  if (samples.length < 2) {
    $("#result-chart").innerHTML = `<svg viewBox="0 0 380 88" role="img" aria-label="最近一次公开平均速度 ${aggregate.mean.toFixed(2)} 千米每小时"><line x1="12" y1="62" x2="367" y2="62" stroke="#e9f0ed" stroke-dasharray="3 4"/><line x1="12" y1="36" x2="367" y2="36" stroke="#f0f4f3" stroke-dasharray="3 4"/><circle cx="190" cy="48" r="5" fill="#128f83"/><circle cx="190" cy="48" r="12" fill="#128f8310"/></svg><div class="chart-caption"><span>公开聚合值</span><span>完成更多统计任务后显示趋势</span></div>`;
    return;
  }
  const minimum = Math.min(...samples), maximum = Math.max(...samples);
  const spread = maximum - minimum || Math.max(Math.abs(maximum) * 0.1, 1);
  const points = samples.map((value, index) => [12 + index * (355 / (samples.length - 1)), 67 - ((value - minimum + spread * 0.2) / (spread * 1.4)) * 56]);
  const line = points.map((point) => point.join(",")).join(" ");
  $("#result-chart").innerHTML = `<svg viewBox="0 0 380 88" role="img" aria-label="最近 ${samples.length} 次公开平均速度：${samples.map((value) => value.toFixed(2)).join("、")} 千米每小时"><defs><linearGradient id="aggregate-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#128f83" stop-opacity=".11"/><stop offset="100%" stop-color="#128f83" stop-opacity="0"/></linearGradient></defs><line x1="12" y1="72" x2="367" y2="72" stroke="#e9f0ed" stroke-dasharray="3 4"/><line x1="12" y1="40" x2="367" y2="40" stroke="#f0f4f3" stroke-dasharray="3 4"/><polygon points="12,79 ${line} 367,79" fill="url(#aggregate-fill)"/><polyline points="${line}" fill="none" stroke="#128f83" stroke-width="2" stroke-linejoin="round"/>${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2" fill="#fff" stroke="#128f83" stroke-width="1.7"/>`).join("")}</svg><div class="chart-caption"><span>最近 ${samples.length} 次公开聚合值</span><span>${minimum.toFixed(2)} – ${maximum.toFixed(2)} km/h</span></div>`;
}

function renderEvents() {
  const events = [...(currentState.events ?? [])].sort((a, b) => Number.isFinite(Number(a.id)) && Number.isFinite(Number(b.id)) ? Number(b.id) - Number(a.id) : String(b.at ?? "").localeCompare(String(a.at ?? ""))).slice(0, 100);
  const fingerprint = JSON.stringify(events);
  if (fingerprint === lastEventsFingerprint) return;
  lastEventsFingerprint = fingerprint;
  const expandedIds = new Set($$("#events-body details[open]").map((element) => element.closest("[data-event-id]").dataset.eventId));
  $("#events-empty").hidden = events.length > 0;
  $("#events-body").innerHTML = events.map((event) => {
    const details = event.details ?? {};
    const summary = typeof details === "object" ? details.message ?? details.reason ?? details.code ?? "查看完整证据" : details;
    return `<tr data-event-id="${escapeHTML(event.id)}"><td>${escapeHTML(formatTime(event.at, true))}<small>证据 #${escapeHTML(event.id)}</small></td><td><span class="event-kind">${escapeHTML(event.kind)}</span></td><td>${escapeHTML(event.claimed_identity ?? "未声明")}</td><td class="${event.verified_identity ? "verified-identity" : "identity-unknown"}">${escapeHTML(event.verified_identity ?? "未提供")}</td><td class="event-details"><details><summary>${escapeHTML(summary)}</summary><pre>${escapeHTML(readable(details))}</pre></details></td></tr>`;
  }).join("");
  $$("#events-body [data-event-id]").forEach((row) => { if (expandedIds.has(row.dataset.eventId)) row.querySelector("details").open = true; });
}

function renderReportOptions() {
  const tasks = sortedTasks().filter((task) => getReport(task));
  const ids = tasks.map((task) => task.id).join("|");
  if (ids === reportOptionIds) return;
  reportOptionIds = ids;
  const previous = $("#report-select").value;
  $("#report-select").innerHTML = tasks.length ? tasks.map((task) => `<option value="${escapeHTML(task.id)}">${escapeHTML(formatTime(task.created_at))} · ${escapeHTML(task.id)}</option>`).join("") : '<option value="">暂无可验证报告</option>';
  if (tasks.some((task) => task.id === previous)) $("#report-select").value = previous;
  if (!lastLoadedReportId && tasks.length && !$("#report-json").value.trim()) loadReport(tasks[0].id);
}

function loadReport(taskId) {
  const task = currentState.tasks.find((entry) => entry.id === taskId);
  if (!getReport(task)) return;
  lastLoadedReportId = taskId;
  $("#report-select").value = taskId;
  $("#report-json").value = JSON.stringify(getReport(task), null, 2);
  $("#download-report").href = `/api/reports/${encodeURIComponent(taskId)}/download`;
  $("#download-report").classList.remove("disabled");
  $("#verification-outcome").className = "panel verification-outcome";
  $("#verification-outcome").innerHTML = '<span class="outcome-symbol">◇</span><h3>报告已载入</h3><p>点击验证数字签名，检查报告的完整性与来源。</p>';
}

function renderExperimentCards() {
  $("#experiment-grid").innerHTML = experiments.map((experiment) => `<article class="experiment-card" id="experiment-${experiment.id}"><div class="experiment-heading"><span class="experiment-symbol">${experiment.symbol}</span><span class="experiment-category">${experiment.category}</span></div><h2>${experiment.title}</h2><p>${experiment.description}</p><button class="secondary-button" data-experiment="${experiment.id}">运行实验<span>↗</span></button><div class="experiment-result" hidden></div></article>`).join("");
}

function renderExperimentResult(scenario, response) {
  const element = $(`#experiment-${scenario} .experiment-result`);
  if (!element) return;
  element.hidden = false;
  const success = response.blocked === true;
  const label = scenario === "ciphertext" ? (success ? "认证解密已拒绝篡改" : "未检测到篡改") : success ? "保护机制已阻断" : "未被阻断";
  element.innerHTML = `<span class="status-tag ${success ? "completed" : "failed"}">${label}</span><strong>${escapeHTML(response.layer ?? "校验结果")}</strong><p>${escapeHTML(response.message ?? response.code ?? "实验已返回")}</p>${response.code ? `<p>校验代码：${escapeHTML(response.code)}</p>` : ""}${response.event_id ? `<button class="evidence-link" data-evidence-id="${escapeHTML(response.event_id)}">查看证据 ↗ ${escapeHTML(response.event_id)}</button>` : ""}${response.details ? `<details><summary>实验细节</summary><pre>${escapeHTML(readable(response.details))}</pre></details>` : ""}`;
}

function renderTaskDetail(task) {
  if (!task) return;
  const fingerprint = JSON.stringify(task);
  if (fingerprint === lastDialogFingerprint && $("#task-detail").hasChildNodes()) return;
  lastDialogFingerprint = fingerprint;
  const [label, className] = statusInfo(task.status);
  const steps = task.steps ?? [];
  const report = getReport(task);
  const result = task.result ?? task.output ?? task.explanation ?? task.verification;
  const analysisSections = [ ["确认事实", "facts"], ["可能原因", "possible_causes"], ["处理建议", "recommendations"], ["不确定性与边界", "uncertainties"] ];
  const analysis = task.analysis ? `<div class="analysis-block"><h3>证据分析</h3>${analysisSections.map(([title, key]) => task.analysis[key] ? `<div class="analysis-section"><strong>${title}</strong><ul>${(Array.isArray(task.analysis[key]) ? task.analysis[key] : [task.analysis[key]]).map((item) => `<li>${escapeHTML(readable(item))}</li>`).join("")}</ul></div>` : "").join("")}${task.analysis.evidence_ids?.length ? `<div class="analysis-evidence">引用证据${task.analysis.evidence_ids.map((id) => `<button data-evidence-id="${escapeHTML(id)}">${escapeHTML(id)}</button>`).join("")}</div>` : ""}</div>` : "";
  $("#task-detail").innerHTML = `<div class="task-detail-request">${escapeHTML(task.request ?? "协作任务")}</div><div class="task-detail-meta"><span class="status-tag ${className}">${label}</span><span>${escapeHTML(task.id)}</span><span>${escapeHTML(formatTime(task.created_at, true))}</span></div>${task.summary ? `<div class="task-summary">${escapeHTML(task.summary)}</div>` : ""}${steps.length ? steps.map((step, index) => `<div class="task-step"><span class="step-index">${String(index + 1).padStart(2, "0")}</span><div class="step-content"><div class="step-title">${escapeHTML(step.action ?? step.agent ?? "安全工具执行")}<small>${escapeHTML(step.agent ?? "")}</small></div><p class="step-detail">${escapeHTML(readable(step.detail ?? step.description ?? ""))}</p></div><span class="status-tag ${statusInfo(step.status)[1]}">${statusInfo(step.status)[0]}</span></div>`).join("") : '<div class="empty-state compact"><strong>等待执行步骤</strong><p>运行过程中将逐步显示工具执行与证据记录。</p></div>'}${result != null ? `<div class="task-detail-result">${escapeHTML(readable(result))}</div>` : ""}${analysis}${task.error ? `<div class="task-error">${escapeHTML(readable(task.error))}</div>` : ""}${report ? `<div class="task-detail-actions"><button class="primary-button" data-load-report="${escapeHTML(task.id)}">查看并验证报告<span>↗</span></button></div>` : ""}`;
}

async function openTask(taskId) {
  dialogTaskId = taskId;
  const task = currentState.tasks.find((entry) => entry.id === taskId);
  renderTaskDetail(task);
  if (!$("#task-dialog").open) $("#task-dialog").showModal();
  try {
    const fresh = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    upsertTask(fresh);
    if (dialogTaskId === taskId) renderTaskDetail(fresh);
  } catch (error) { toast(error.message, true); }
}

function upsertTask(task) {
  if (!task?.id) return;
  const index = currentState.tasks.findIndex((entry) => entry.id === task.id);
  if (index < 0) currentState.tasks.push(task); else currentState.tasks[index] = task;
  renderTasks(); renderResults(); renderReportOptions(); renderStats();
}

async function refreshState(silent = true) {
  if (stateFetching) return;
  stateFetching = true;
  try {
    const state = await api("/api/state");
    currentState = { nodes: [], tasks: [], events: [], ...state };
    $("#connection-status").className = "connection-status";
    $("#connection-status").innerHTML = "<i></i>实验环境已连接";
    $("#connection-error").hidden = true;
    renderStats(); renderArchitecture(); renderTasks(); renderResults(); renderEvents(); renderReportOptions();
    if (!silent) toast("系统状态已刷新。");
  } catch (error) {
    $("#connection-status").className = "connection-status offline";
    $("#connection-status").innerHTML = "<i></i>连接中断";
    $("#connection-error").hidden = false;
    $("#connection-error").textContent = `无法读取实验环境：${error.message} 请确认服务已启动；恢复连接后页面会自动更新。`;
    if (!silent) toast(error.message, true);
  } finally { stateFetching = false; }
}

async function pollTask(taskId) {
  if (pollingTasks.has(taskId)) return;
  pollingTasks.add(taskId);
  let attempts = 0;
  const next = async () => {
    try {
      const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
      upsertTask(task);
      const status = statusInfo(task.status)[1];
      if (["completed", "failed"].includes(status)) {
        pollingTasks.delete(taskId);
        toast(status === "completed" ? "协作任务已完成，可以查看执行记录与签名报告。" : `任务未完成：${typeof task.error === "string" ? task.error : "请查看执行记录"}`, status === "failed");
        await refreshState();
        return;
      }
      if (++attempts < 200) setTimeout(next, 2000);
      else pollingTasks.delete(taskId);
    } catch (error) { pollingTasks.delete(taskId); toast(`任务轮询中断：${error.message}`, true); }
  };
  setTimeout(next, 1500);
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const request = $("#task-request").value.trim();
  if (!request) { $("#task-request").focus(); return; }
  const button = $("#submit-task");
  setBusy(button, true, "正在发起…");
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify({ request, request_id: crypto.randomUUID(), road: "S101", window_seconds: 60 }) });
    upsertTask(task);
    toast("协作任务已创建，正在执行安全工具。");
    await refreshState();
    if (!["completed", "failed"].includes(statusInfo(task.status)[1])) pollTask(task.id);
  } catch (error) { toast(`发起任务失败：${error.message}`, true); }
  finally { setBusy(button, false); }
});

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) changeView(nav.dataset.view);
  const prompt = event.target.closest("[data-prompt]");
  if (prompt) { $("#task-request").value = prompt.dataset.prompt; $("#task-request").focus(); }
  const task = event.target.closest("[data-task-id]");
  if (task) openTask(task.dataset.taskId);
  const load = event.target.closest("[data-load-report]");
  if (load) { $("#task-dialog").close(); changeView("verification"); loadReport(load.dataset.loadReport); }
  const evidence = event.target.closest("[data-evidence-id]");
  if (evidence) {
    if ($("#task-dialog").open) $("#task-dialog").close();
    changeView("evidence");
    const row = $$("[data-event-id]").find((entry) => entry.dataset.eventId === evidence.dataset.evidenceId);
    if (row) { row.classList.add("event-highlight"); row.querySelector("details").open = true; row.scrollIntoView({ block: "center", behavior: "smooth" }); setTimeout(() => row.classList.remove("event-highlight"), 4500); }
    else toast(`证据 #${evidence.dataset.evidenceId} 超出当前最近事件列表，可查阅完整审计记录。`);
  }
  const experiment = event.target.closest("[data-experiment]");
  if (experiment) {
    const scenario = experiment.dataset.experiment;
    setBusy(experiment, true, scenario === "dropout" ? "正在等待节点…" : "实验执行中…");
    try {
      const response = await api("/api/experiments", { method: "POST", body: JSON.stringify({ scenario }) });
      experimentResponses.set(scenario, response);
      renderExperimentResult(scenario, response);
      toast(response.message ?? "实验完成，已显示实际校验结果。", response.blocked === false);
      await refreshState();
    } catch (error) {
      const output = $(`#experiment-${scenario} .experiment-result`);
      output.hidden = false; output.textContent = `实验请求失败：${error.message}`;
      toast(error.message, true);
    } finally { setBusy(experiment, false); }
  }
});

$("#task-list").addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key) && event.target.dataset.taskId) { event.preventDefault(); openTask(event.target.dataset.taskId); } });
$("#refresh-button").addEventListener("click", () => refreshState(false));
$("#close-task-dialog").addEventListener("click", () => $("#task-dialog").close());
$("#task-dialog").addEventListener("click", (event) => { if (event.target === $("#task-dialog")) { const rect = $("#task-dialog").getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $("#task-dialog").close(); } });
$("#report-select").addEventListener("change", (event) => loadReport(event.target.value));

$("#verify-report").addEventListener("click", async () => {
  const button = $("#verify-report");
  let envelope;
  try { envelope = JSON.parse($("#report-json").value); if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("需要 JSON 对象格式的报告 envelope。"); }
  catch (error) { toast(`报告 JSON 无效：${error.message}`, true); return; }
  setBusy(button, true, "正在校验…");
  try {
    const result = await api("/api/reports/verify", { method: "POST", body: JSON.stringify({ envelope }) });
    const valid = result.valid === true;
    $("#verification-outcome").className = `panel verification-outcome ${valid ? "valid" : "invalid"}`;
    $("#verification-outcome").innerHTML = `<span class="outcome-symbol">${valid ? "✓" : "×"}</span><h3>${valid ? "签名验证通过" : "签名验证未通过"}</h3><p>${escapeHTML(result.reason ?? result.message ?? (valid ? "报告内容与签发时一致。" : "报告内容或签发身份无法通过校验。"))}</p><details><summary>服务端验证详情</summary><pre>${escapeHTML(readable(result))}</pre></details>`;
    toast(valid ? "报告数字签名有效。" : "报告验证失败，详情已显示。", !valid);
    await refreshState();
  } catch (error) { toast(`验证请求失败：${error.message}`, true); }
  finally { setBusy(button, false); }
});

$("#alter-report").addEventListener("click", () => {
  try {
    const envelope = JSON.parse($("#report-json").value);
    let changed = false;
    const mutate = (object) => {
      if (!object || typeof object !== "object" || changed) return;
      for (const key of ["mean_speed_kmh", "mean_speed", "average_speed_kmh", "average_speed", "mean_kmh", "mean"]) {
        if (object[key] != null && Number.isFinite(Number(object[key]))) { object[key] = Number(object[key]) + 1; changed = true; return; }
      }
      for (const [key, value] of Object.entries(object)) if (!/signature|certificate|public_key/i.test(key)) mutate(value);
    };
    mutate(envelope);
    if (!changed) {
      const body = envelope.payload ?? envelope.report ?? envelope.data ?? envelope.body;
      if (body && typeof body === "object" && !Array.isArray(body)) body.verification_test_note = "内容已在控制台修改";
      else { toast("未找到可修改的报告结果字段，请直接编辑 JSON 中的已签署内容。", true); return; }
    }
    $("#report-json").value = JSON.stringify(envelope, null, 2);
    $("#verification-outcome").className = "panel verification-outcome";
    $("#verification-outcome").innerHTML = '<span class="outcome-symbol">≠</span><h3>报告内容已修改</h3><p>签名保持原值。点击验证，检查内容变化是否被识别。</p>';
    toast("已修改公开结果字段。再次验证观察签名校验结果。");
  } catch (error) { toast(`无法修改报告：${error.message}`, true); }
});

$("#check-audit").addEventListener("click", async () => {
  const button = $("#check-audit"); setBusy(button, true, "校验中…");
  try {
    const result = await api("/api/audit/verify");
    const output = $("#audit-result"); output.hidden = false; output.className = `audit-proof${result.valid === false ? " invalid" : ""}`;
    output.innerHTML = `<strong>${result.valid === true ? "审计链校验通过" : "审计链校验未通过"}</strong><pre>${escapeHTML(readable(result))}</pre>`;
    await refreshState();
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#checkpoint-button").addEventListener("click", async () => {
  const button = $("#checkpoint-button"); setBusy(button, true, "正在签署…");
  try {
    const checkpoint = await api("/api/audit/checkpoint", { method: "POST", body: JSON.stringify({}) });
    $("#checkpoint-panel").hidden = false; $("#checkpoint-json").textContent = JSON.stringify(checkpoint, null, 2);
    toast("审计检查点已签署。"); await refreshState();
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
});

renderExperimentCards();
changeView(location.hash.slice(1) || "workspace");
refreshState();
setInterval(() => { if (!document.hidden) refreshState(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });

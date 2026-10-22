"use strict";

(() => {
  const find = (id) => document.getElementById(id);
  const scrollArea = find("conversation-scroll");
  const messages = find("chat-messages");
  const selector = find("chat-session-select");
  const snapshots = new Map();
  const streams = new Map();
  const notified = new Set();
  let selectedId = null;
  let selectionInitialized = false;
  let pending = null;
  let lastFingerprint = "";
  let lastOptions = "";
  let lastInspectorFingerprint = "";
  let forceScroll = false;
  const kinds = {
    model: ["✧", "模型调用与显式说明", "模型动作说明"],
    tool: ["⌘", "安全工具调度", "执行层记录"],
    security: ["▣", "签名、认证与授权", "执行层记录"],
    exchange: ["⇄", "节点间信息交换", "执行层记录"],
    mpc: ["Σ", "隐私计算与聚合", "执行层记录"],
    report: ["◇", "报告签署与审计", "执行层记录"],
    analysis: ["⌁", "任务规划与证据分析", "动作记录"],
  };
  const phases = [["编排", ["model", "tool", "analysis"]], ["认证授权", ["security"]], ["信息交换", ["exchange"]], ["隐私计算", ["mpc"]], ["报告审计", ["report"]]];
  const terminal = (task) => ["completed", "failed"].includes(statusInfo(task?.status)[1]);
  const nearBottom = () => scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 90;
  const safe = (value) => escapeHTML(value);

  function stepKind(step) {
    if (kinds[step.kind]) return step.kind;
    const name = `${step.action ?? ""} ${step.agent ?? ""}`;
    if (/签名与保存|报告服务|发布报告|审计写入/.test(name)) return "report";
    if (/认证|授权|解密|校验|签名|预算/.test(name)) return "security";
    if (/交换|传输|通信|发送|接收/.test(name)) return "exchange";
    if (/协议|聚合|联合统计|隐私计算/.test(name)) return "mpc";
    if (/model|大模型|模型请求/.test(name)) return "model";
    return "analysis";
  }

  function uniqueSteps(task) {
    const result = [], positions = new Map();
    for (const [index, step] of (task?.steps ?? []).entries()) {
      const id = String(step.id ?? `legacy-${index}`);
      if (positions.has(id)) result[positions.get(id)] = { ...step, traceId: id };
      else { positions.set(id, result.length); result.push({ ...step, traceId: id }); }
    }
    return result;
  }

  function taskMode(task) {
    const report = getReport(task);
    const context = task?.model_context ?? {};
    const mode = context.mode ?? task?.mode ?? report?.payload?.mode;
    const model = context.model ?? task?.model;
    return mode === "llm" ? `API Token${model ? ` · ${model}` : ""}` : mode === "demo" ? "Demo · 本地编排" : "历史任务 · 模式未记录";
  }

  function taskList() {
    const all = new Map((currentState.tasks ?? []).map((task) => [task.id, task]));
    for (const [id, task] of snapshots) all.set(id, task);
    return [...all.values()].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
  }

  function renderOptions(tasks) {
    const fingerprint = JSON.stringify(tasks.map((task) => [task.id, task.status, task.request]));
    if (fingerprint !== lastOptions) {
      lastOptions = fingerprint;
      selector.replaceChildren();
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = "新会话"; selector.append(blank);
      for (const task of tasks) {
        const option = document.createElement("option");
        option.value = task.id;
        option.textContent = `${statusInfo(task.status)[0]} · ${String(task.request ?? "协作任务").slice(0, 46)}`;
        selector.append(option);
      }
    }
    selector.value = selectedId ?? "";
  }

  function evidenceLinks(ids) {
    if (!Array.isArray(ids) || !ids.length) return "";
    return `<div class="trace-evidence-links">${ids.slice(0, 12).map((id) => `<button data-evidence-id="${safe(id)}">证据 #${safe(id)} ↗</button>`).join("")}${ids.length > 12 ? `<span>另 ${ids.length - 12} 条</span>` : ""}</div>`;
  }

  function route(step) {
    if (!step.sender && !step.recipient) return "";
    return `<div class="trace-route"><span>${safe(step.sender ?? "未记录发送方")}</span><b aria-hidden="true">→</b><span>${safe(step.recipient ?? "未记录接收方")}</span>${step.protocol ? `<span>· ${safe(step.protocol)}</span>` : ""}</div>`;
  }

  function renderStep(step) {
    const [label, state] = statusInfo(step.status);
    const metadata = step.metadata && Object.keys(step.metadata).length ? `<details class="trace-step-public" data-trace-detail="${safe(step.traceId)}"><summary>公开协议元数据</summary><pre>${safe(readable(step.metadata))}</pre></details>` : "";
    return `<div class="chat-trace-step ${state}"><div class="trace-step-heading"><strong>${safe(step.action ?? "安全动作")}</strong>${step.metadata?.source === "worker" ? '<span class="trace-worker-source">工作进程进度</span>' : ""}${step.at ? `<time>${safe(formatTime(step.at))}</time>` : ""}<span class="trace-step-state">${safe(label)}</span></div><p class="trace-step-detail">${safe(readable(step.detail ?? ""))}</p>${route(step)}${metadata}${evidenceLinks(step.evidence_ids)}</div>`;
  }

  function traceGroups(steps) {
    const groups = [];
    for (const step of steps) {
      const kind = stepKind(step);
      const previous = groups.at(-1);
      if (previous?.kind === kind) previous.steps.push(step);
      else groups.push({ kind, id: step.traceId, steps: [step] });
    }
    return groups.map((group) => {
      const [symbol, title, source] = kinds[group.kind];
      return `<details class="trace-group" data-trace-group="${safe(group.id)}" open><summary><span>${symbol}</span><strong>${safe(title)}</strong><span class="trace-group-count">${group.steps.length} 个动作 · ${safe(source)}</span></summary><div class="trace-steps">${group.steps.map(renderStep).join("")}</div></details>`;
    }).join("");
  }

  function analysisMarkup(task) {
    if (!task.analysis) return "";
    const sections = [["确认事实", "facts"], ["可能原因", "possible_causes"], ["建议", "recommendations"], ["不确定性与边界", "uncertainties"]];
    return `<div class="chat-analysis">${sections.map(([title, key]) => {
      const items = task.analysis[key];
      return Array.isArray(items) && items.length ? `<h4>${title}</h4><ul>${items.map((item) => `<li>${safe(readable(item))}</li>`).join("")}</ul>` : "";
    }).join("")}${evidenceLinks(task.analysis.evidence_ids)}</div>`;
  }

  function userMarkup(task) {
    return `<article class="chat-message user-message"><div class="message-meta"><span>你</span><span>${safe(formatTime(task.created_at))}</span></div><div class="user-message-bubble">${safe(task.request ?? "协作任务")}</div></article>`;
  }

  function taskMarkup(task) {
    const steps = uniqueSteps(task), [label, state] = statusInfo(task.status);
    const active = [...steps].reverse().find((step) => statusInfo(step.status)[1] === "running") ?? steps.at(-1);
    const running = !terminal(task);
    const title = state === "completed" ? "可信协作已完成" : state === "failed" ? "任务已停止，保留实际执行记录" : active?.action ?? (state === "queued" ? "请求已接收，等待执行" : "正在启动协作");
    const caption = running ? active?.agent ?? "服务端执行层" : `${steps.length} 个已记录动作 · ${taskMode(task)}`;
    const result = getAggregate(task);
    const participantCount = Array.isArray(result?.participants) ? result.participants.length : result?.participants ?? 3;
    const aggregate = result ? `<div class="chat-result-card"><div class="chat-result-label"><span>${safe(result.road)} 路段 · 公开聚合均值</span><span>AGGREGATE ONLY</span></div><div class="chat-result-number">${result.mean.toFixed(2)}<small>km/h</small></div><div class="chat-result-caption">${safe(participantCount)} 个参与节点 · ${safe(result.window ?? task.window_seconds ?? "60")} 秒窗口 · 不展示单车输入</div></div>` : "";
    const failure = state === "failed" ? `<div class="chat-failure-note">${safe(typeof task.error === "string" ? task.error : task.error?.message ?? "执行未完成，请查看上方动作定位失败阶段。")}${task.error?.code ? `\n校验代码：${safe(task.error.code)}` : ""}</div>` : "";
    const reply = task.summary ? `<div class="assistant-response-label"><span>${taskMode(task).startsWith("API Token") ? "模型生成的结果说明" : "任务结果说明"}</span><span>依据已返回的执行结果</span></div><div class="assistant-reply">${safe(task.summary)}</div>` : "";
    const verification = task.verification ? `<div class="chat-verification-result ${task.verification.valid === true ? "valid" : "invalid"}"><strong>报告验签：${task.verification.valid === true ? "通过" : "未通过"}</strong><p>${safe(task.verification.reason ?? "查看报告验证页获取详情。")}</p></div>` : "";
    return `${userMarkup(task)}<article class="chat-message assistant-message"><span class="assistant-avatar" aria-hidden="true">V</span><div class="assistant-message-content"><div class="message-meta"><strong>VECTRA</strong><span class="message-source-tag">${safe(taskMode(task))}</span></div><div class="task-progress-card ${state}"><div class="task-progress-heading"><span aria-hidden="true">${state === "completed" ? "✓" : state === "failed" ? "!" : "⌁"}</span><div><strong>${safe(title)}</strong><p>${safe(caption)}</p></div></div>${traceGroups(steps)}</div>${reply}${aggregate}${verification}${analysisMarkup(task)}${failure}${!running ? `<div class="chat-result-actions">${getReport(task) ? `<button data-chat-report="${safe(task.id)}">打开报告并验签 ↗</button>` : ""}<button data-view="evidence">查看安全证据 ↗</button><button class="quiet" data-chat-task-detail="${safe(task.id)}">完整任务详情 ↗</button>${state === "failed" ? `<button data-chat-retry="${safe(task.id)}">重新填写任务 ↗</button>` : ""}</div>` : ""}</div></article>`;
  }

  function emptyMarkup() {
    return '<div class="chat-welcome"><span class="welcome-brand" aria-hidden="true">V</span><h2>一起完成一次<br>看得见的可信协作。</h2><p>告诉我你的任务。你可以实时看到模型调用、安全校验、节点通信与隐私计算的每一步。</p><div class="welcome-capabilities"><span>▣ 真实安全工具</span><span>⇄ 节点信息交换</span><span>◇ 可追溯执行证据</span></div><div class="welcome-flow"><b>提出任务</b><span>→</span><b>认证与授权</b><span>→</span><b>隐私协作</b><span>→</span><b>签名交付</b></div></div>';
  }

  function pendingMarkup() {
    const failed = pending.status === "failed";
    return `${userMarkup(pending)}<article class="chat-message assistant-message"><span class="assistant-avatar" aria-hidden="true">V</span><div class="assistant-message-content"><div class="message-meta"><strong>VECTRA</strong><span class="message-source-tag">客户端状态</span></div><div class="task-progress-card ${failed ? "failed" : "running"}"><div class="task-progress-heading"><span>${failed ? "!" : "⌁"}</span><div><strong>${failed ? "请求未能创建" : "正在提交协作请求"}</strong><p>${failed ? "尚未获得服务端任务，请检查连接后重新发送。" : "等待服务端接收；随后展示实际执行动作。"}</p></div></div></div>${failed ? `<div class="chat-failure-note">${safe(pending.error)}</div>` : ""}</div></article>`;
  }

  function updateStreamStatus(task) {
    const element = find("chat-stream-status"), stream = task && streams.get(task.id);
    let label = pending ? pending.status === "failed" ? "请求失败" : "正在提交" : "等待任务", style = "";
    if (task) {
      if (terminal(task)) label = "完整执行记录";
      else if (stream?.state === "live") { label = "实时同步"; style = "live"; }
      else if (stream?.state === "reconnecting") { label = "重连中 · 轮询兜底"; style = "reconnecting"; }
      else { label = "正在连接实时流"; style = "reconnecting"; }
    }
    element.className = `chat-stream-status ${style}`;
    element.replaceChildren(document.createElement("i"), document.createTextNode(label));
  }

  function renderInspector(task) {
    const fingerprint = JSON.stringify({ task, nodes: currentState.nodes, pending: pending?.id });
    if (fingerprint === lastInspectorFingerprint) return;
    lastInspectorFingerprint = fingerprint;
    const steps = uniqueSteps(task), active = [...steps].reverse().find((step) => statusInfo(step.status)[1] === "running") ?? steps.at(-1);
    const isRunning = task && !terminal(task), failed = task && statusInfo(task.status)[1] === "failed";
    const activeKind = active && stepKind(active);
    const indicator = find("inspector-live-indicator");
    indicator.textContent = isRunning ? "执行中" : failed ? "已停止" : task ? "已完成" : "待命";
    indicator.className = `inspector-live-indicator ${isRunning ? "active" : failed ? "failed" : ""}`;
    find("current-operation").innerHTML = `<span class="operation-symbol">${task ? failed ? "!" : isRunning ? kinds[activeKind ?? "tool"][0] : "✓" : "⌁"}</span><div><strong>${safe(task ? failed ? "协作在失败阶段停止" : isRunning ? active?.action ?? "等待执行层启动" : "任务已完成" : pending ? "正在提交协作请求" : "等待协作任务")}</strong><p>${safe(active?.detail ? String(active.detail).slice(0, 135) : task ? "此任务尚未记录执行动作。" : "发送任务后，实时追踪安全工具与节点之间的协作。")}</p></div>`;
    find("execution-phases").innerHTML = phases.map(([label, category], index) => {
      const phaseSteps = steps.filter((step) => category.includes(stepKind(step)));
      const failedPhase = phaseSteps.some((step) => statusInfo(step.status)[1] === "failed");
      const runningPhase = phaseSteps.some((step) => statusInfo(step.status)[1] === "running");
      const completedPhase = phaseSteps.length > 0 && phaseSteps.every((step) => statusInfo(step.status)[1] === "completed");
      return `<div class="execution-phase ${failedPhase ? "failed" : runningPhase ? "active" : completedPhase ? "observed" : ""}" title="${label}：${failedPhase ? "有动作失败" : runningPhase ? "有动作执行中" : completedPhase ? "阶段动作已完成" : "尚无已完成动作"}"><i>${failedPhase ? "!" : runningPhase ? "•" : completedPhase ? "✓" : index + 1}</i><span>${label}</span></div>`;
    }).join("");
    const exchanges = steps.filter((step) => stepKind(step) === "exchange");
    find("inspector-metrics").innerHTML = [[steps.filter((step) => stepKind(step) === "security").length, "安全操作"], [exchanges.length, "信息交换"], [steps.filter((step) => stepKind(step) === "model").length, "模型动作"]].map(([count, label]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join("");
    const participants = new Set(steps.flatMap((step) => [step.sender, step.recipient]).filter(Boolean));
    const activeNodes = new Set(isRunning && active ? [active.sender, active.recipient].filter(Boolean) : []);
    const nodes = [...(currentState.nodes ?? [])].filter((node) => /coordinator|rsu|vehicle/i.test(node.id)).slice(0, 6);
    const aliases = { coordinator: "coordinator", rsu: "rsu", "任务协调器": "coordinator", "模板协调器": "coordinator", mpc: "mpc" };
    const matches = (set, id) => [...set].some((value) => value === id || aliases[value] === id);
    find("live-node-map").innerHTML = nodes.length ? nodes.map((node) => {
      const isActive = matches(activeNodes, node.id), involved = matches(participants, node.id);
      return `<div class="live-node ${isActive ? "active" : involved ? "observed" : ""}"><span aria-hidden="true">${/vehicle/i.test(node.id) ? "▱" : /rsu/i.test(node.id) ? "⌁" : "⌘"}</span><strong>${safe(node.id)}</strong><small>${isActive ? "当前动作" : involved ? "已有动作" : "等待消息"}</small></div>`;
    }).join("") : '<div class="communication-empty"><p>正在读取登记节点…</p></div>';
    find("active-node-caption").textContent = task ? `${participants.size} 个动作端点` : "等待任务";
    find("communication-count").textContent = `${exchanges.length} 条`;
    const feed = find("communication-feed"), position = feed.scrollTop;
    const opened = new Set([...feed.querySelectorAll("details[open]")].map((item) => item.dataset.communicationId));
    feed.innerHTML = exchanges.length ? [...exchanges].reverse().map((step) => {
      const [label, state] = statusInfo(step.status), outcome = step.metadata?.outcome;
      const outcomeLabel = outcome === "accepted" ? "执行层返回：接受" : outcome === "rejected" ? "执行层返回：拒绝" : `执行状态：${label}`;
      return `<article class="communication-card"><div class="communication-route"><span>${safe(step.sender ?? "未记录发送方")}</span><b aria-label="发送到">→</b><span>${safe(step.recipient ?? "未记录接收方")}</span>${step.protocol ? `<span class="communication-protocol">${safe(step.protocol)}</span>` : ""}</div><h4>${safe(step.action)}</h4><div class="communication-meta-line"><span class="${state === "completed" ? "verified" : ""}">${safe(outcomeLabel)}</span><span>·</span><time>${safe(formatTime(step.at))}</time></div>${step.metadata && Object.keys(step.metadata).length ? `<details data-communication-id="${safe(step.traceId)}"><summary>查看公开元数据</summary><pre>${safe(readable(step.metadata))}</pre></details>` : ""}${evidenceLinks(step.evidence_ids)}</article>`;
    }).join("") : '<div class="communication-empty"><span>⇄</span><p>节点之间每一次可公开的信息交换<br>都会在这里留下轨迹</p></div>';
    for (const detail of feed.querySelectorAll("details")) detail.open = opened.has(detail.dataset.communicationId);
    feed.scrollTop = position;
  }

  function render() {
    const tasks = taskList();
    renderOptions(tasks);
    const task = tasks.find((item) => item.id === selectedId) ?? null;
    updateStreamStatus(task);
    const fingerprint = JSON.stringify({ task, pending });
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      const follow = forceScroll || nearBottom(), position = scrollArea.scrollTop;
      const detailStates = new Map([...messages.querySelectorAll("details")].map((detail) => [detail.dataset.traceGroup ?? detail.dataset.traceDetail, detail.open]));
      messages.innerHTML = pending ? pendingMarkup() : task ? taskMarkup(task) : emptyMarkup();
      for (const detail of messages.querySelectorAll("details")) {
        const id = detail.dataset.traceGroup ?? detail.dataset.traceDetail;
        if (detailStates.has(id)) detail.open = detailStates.get(id);
      }
      if (!pending && !task) { scrollArea.scrollTop = 0; find("jump-to-latest").hidden = true; }
      else if (follow) { scrollArea.scrollTop = scrollArea.scrollHeight; find("jump-to-latest").hidden = true; }
      else { scrollArea.scrollTop = position; find("jump-to-latest").hidden = false; }
      forceScroll = false;
    }
    renderInspector(task);
  }

  function stopStream(id) {
    const stream = streams.get(id);
    if (!stream) return;
    stream.source?.close();
    clearTimeout(stream.timer);
    streams.delete(id);
  }

  function receiveTask(task, notify = true) {
    if (!task?.id || !Array.isArray(task.steps)) return;
    const activeStream = streams.get(task.id);
    if (activeStream) activeStream.revision += 1;
    snapshots.set(task.id, task);
    if (terminal(task)) stopStream(task.id);
    upsertTask(task);
    if (terminal(task) && notify && !notified.has(task.id)) {
      notified.add(task.id);
      toast(statusInfo(task.status)[1] === "completed" ? "协作已完成，动作、交换记录与签名报告已保留。" : "任务已停止，查看会话中的失败动作。", statusInfo(task.status)[1] === "failed");
      refreshState();
    }
  }

  function startFallback(id, stream) {
    if (stream.timer || stream.polling) return;
    const poll = async () => {
      stream.timer = null;
      if (streams.get(id) !== stream || stream.state === "live") return;
      stream.polling = true;
      const revision = stream.revision;
      try {
        const snapshot = await api(`/api/tasks/${encodeURIComponent(id)}`);
        if (streams.get(id) === stream && stream.state !== "live" && stream.revision === revision) receiveTask(snapshot);
      }
      catch { /* Keep the last complete snapshot while the service reconnects. */ }
      finally { stream.polling = false; }
      if (streams.get(id) === stream && stream.state !== "live" && !stream.timer) stream.timer = setTimeout(poll, 1800);
    };
    stream.timer = setTimeout(poll, 600);
  }

  function watchTask(id) {
    const task = taskList().find((item) => item.id === id);
    if (streams.has(id) || (task && terminal(task))) return;
    const stream = { source: null, timer: null, state: "connecting", revision: 0, polling: false };
    streams.set(id, stream);
    if (typeof EventSource === "undefined") { stream.state = "reconnecting"; startFallback(id, stream); render(); return; }
    try {
      stream.source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
      stream.source.addEventListener("open", () => {
        if (streams.get(id) !== stream) return;
        stream.state = "live"; clearTimeout(stream.timer); stream.timer = null; render();
      });
      stream.source.addEventListener("task", (event) => {
        if (streams.get(id) !== stream) return;
        try {
          const task = JSON.parse(event.data);
          stream.state = "live"; clearTimeout(stream.timer); stream.timer = null;
          receiveTask(task);
        }
        catch { stream.state = "reconnecting"; startFallback(id, stream); render(); }
      });
      stream.source.addEventListener("error", () => {
        if (streams.get(id) !== stream) return;
        stream.state = "reconnecting"; startFallback(id, stream); render();
      });
    } catch { stream.state = "reconnecting"; startFallback(id, stream); }
    render();
  }

  function selectTask(id) {
    selectedId = id || null; pending = null; selectionInitialized = true;
    lastFingerprint = ""; forceScroll = true;
    render();
    const task = taskList().find((item) => item.id === id);
    if (task && !terminal(task)) watchTask(id);
    if (activeView !== "workspace") changeView("workspace");
    find("conversation-scroll").focus({ preventScroll: true });
  }

  window.VectraChat = {
    sync(state) {
      for (const task of state.tasks ?? []) {
        const prior = snapshots.get(task.id);
        if (!prior || !streams.has(task.id) && (!terminal(prior) || terminal(task))) snapshots.set(task.id, task);
      }
      const tasks = taskList();
      if (!selectionInitialized && tasks.length) { selectedId = tasks[0].id; selectionInitialized = true; forceScroll = true; }
      render();
      for (const task of tasks.filter((item) => !terminal(item)).slice(0, 3)) watchTask(task.id);
    },
    beginRequest(request) {
      selectionInitialized = true; selectedId = null;
      pending = { id: crypto.randomUUID(), request, created_at: Date.now() / 1000, status: "running" };
      forceScroll = true; render(); return pending.id;
    },
    acceptRequest(localId, task) {
      if (pending?.id === localId) pending = null;
      selectedId = task.id; snapshots.set(task.id, task); forceScroll = true; render();
    },
    rejectRequest(localId, error) { if (pending?.id === localId) { pending.status = "failed"; pending.error = error; render(); } },
    selectTask, watchTask,
    resume() { render(); },
  };

  selector.addEventListener("change", () => selectTask(selector.value));
  find("new-conversation").addEventListener("click", () => { selectTask(null); find("task-request").focus(); });
  find("jump-to-latest").addEventListener("click", () => { scrollArea.scrollTop = scrollArea.scrollHeight; find("jump-to-latest").hidden = true; });
  scrollArea.addEventListener("scroll", () => { if (nearBottom()) find("jump-to-latest").hidden = true; }, { passive: true });
  find("task-request").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!find("submit-task").disabled) find("task-form").requestSubmit(); }
  });
  document.addEventListener("click", (event) => {
    const report = event.target.closest("[data-chat-report]");
    if (report) { changeView("verification"); loadReport(report.dataset.chatReport); }
    const detail = event.target.closest("[data-chat-task-detail]");
    if (detail) openTask(detail.dataset.chatTaskDetail);
    const retry = event.target.closest("[data-chat-retry]");
    if (retry) { find("task-request").value = taskList().find((task) => task.id === retry.dataset.chatRetry)?.request ?? ""; find("task-request").focus(); }
  });
  window.addEventListener("beforeunload", () => { for (const id of streams.keys()) stopStream(id); });
  window.VectraChat.sync(currentState);
})();

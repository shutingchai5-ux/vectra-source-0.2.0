<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Analysis, AuditEvent, JsonObject, Verification } from "@vectra/shared";
import { api, time } from "../api";
import { actorLabel } from "../conversation";
import { auditTaskId, describeAuditEvent, evidenceCategories, filterEvidence, needsAttention, type EvidenceCategory } from "../evidence";
import { useWorkspace } from "../stores/workspace";
import MarkdownContent from "../components/MarkdownContent.vue";
import ProtocolSection from "../components/ProtocolSection.vue";

type AuditVerification = Verification & { verifiedAt: number; count: number };
type Pane = "events" | "analysis" | "integrity";
const workspace = useWorkspace(), route = useRoute(), router = useRouter();
const panes: { id: Pane; label: string; description: string }[] = [
  { id: "events", label: "分类事件", description: "查找与追踪执行记录" },
  { id: "analysis", label: "证据分析", description: "阅读事实、原因与建议" },
  { id: "integrity", label: "审计校验", description: "检查完整性与签名检查点" },
];
const pane = ref<Pane>("events"), events = ref<AuditEvent[]>([]), loading = ref(false), loadError = ref(false), loaded = ref(false);
const category = ref<EvidenceCategory | "all">("all"), keyword = ref(""), taskId = ref(""), attentionOnly = ref(false);
const expanded = ref(new Set<number>());
const analysis = ref<Analysis | null>(null), analyzing = ref(false), analysisError = ref(false), selectedId = ref<number>();
const verification = ref<AuditVerification | null>(null), verifying = ref(false), checkpoint = ref<JsonObject | null>(null), checkpointBusy = ref(false);
let analysisRequest = 0;
const requests = new AbortController();
const fields = [{ label: "确认事实", key: "facts" }, { label: "可能原因", key: "possibleCauses" }, { label: "处理建议", key: "recommendations" }, { label: "不确定性与边界", key: "uncertainties" }] as const;
const routeEventId = computed(() => {
  const value = route.query.event;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
});
const categories = computed(() => evidenceCategories.map(item => ({ ...item, count: events.value.filter(event => describeAuditEvent(event).category === item.id).length })));
const tasks = computed(() => [...new Set(events.value.map(auditTaskId).filter(Boolean))]);
const attentionCount = computed(() => events.value.filter(needsAttention).length);
const filtered = computed(() => filterEvidence(events.value, { category: category.value, keyword: keyword.value, taskId: taskId.value, attentionOnly: attentionOnly.value }));
const groups = computed(() => categories.value.map(item => ({ ...item, events: filtered.value.filter(event => describeAuditEvent(event).category === item.id) })).filter(item => item.events.length));
const selectedEvent = computed(() => events.value.find(event => event.id === selectedId.value));
const hasFilters = computed(() => category.value !== "all" || keyword.value.trim() || taskId.value || attentionOnly.value);

function resetFilters() { category.value = "all"; keyword.value = ""; taskId.value = ""; attentionOnly.value = false; }
function toggleDetails(event: Event, id: number) {
  if ((event.target as HTMLDetailsElement).open) expanded.value.add(id);
  else expanded.value.delete(id);
}
async function load() {
  loading.value = true; loadError.value = false;
  try {
    const data = await api<{ events: AuditEvent[]; verification: AuditVerification | null }>("/api/evidence", { signal: requests.signal });
    events.value = data.events; verification.value = data.verification; loaded.value = true;
  } catch (cause) { if (!requests.signal.aborted) { loadError.value = true; workspace.fail(cause); } }
  finally { loading.value = false; }
}
async function investigate(id?: number) {
  const requestId = ++analysisRequest;
  selectedId.value = id; pane.value = "analysis"; analysis.value = null; analyzing.value = true; analysisError.value = false;
  try {
    const result = await api<Analysis>(`/api/evidence/analysis${id ? `?eventId=${id}` : ""}`, { signal: requests.signal });
    if (requestId === analysisRequest) { analysis.value = result; selectedId.value = id ?? result.evidenceIds[0]; }
  } catch (cause) { if (!requests.signal.aborted && requestId === analysisRequest) { analysisError.value = true; workspace.fail(cause); } }
  finally { if (requestId === analysisRequest) analyzing.value = false; }
}
async function chooseEvent(id?: number) {
  if (routeEventId.value === id) { await investigate(id); return; }
  await router.replace({ query: { ...route.query, event: id?.toString() } });
  if (!id) await investigate();
}
async function verify() {
  pane.value = "integrity"; verifying.value = true;
  try { verification.value = await api<AuditVerification>("/api/audit/verify", { method: "POST", signal: requests.signal }); }
  catch (cause) { if (!requests.signal.aborted) workspace.fail(cause); }
  finally { verifying.value = false; }
}
async function signCheckpoint() {
  checkpointBusy.value = true;
  try { checkpoint.value = await api<JsonObject>("/api/audit/checkpoint", { method: "POST", signal: requests.signal }); }
  catch (cause) { if (!requests.signal.aborted) workspace.fail(cause); }
  finally { checkpointBusy.value = false; }
}
function followTask(id: string) { resetFilters(); taskId.value = id; pane.value = "events"; }
watch(routeEventId, id => { if (id) void investigate(id); }, { immediate: true });
onMounted(load);
onUnmounted(() => { analysisRequest++; requests.abort(); });
</script>

<template>
  <div class="evidence-page">
    <div class="page-heading">
      <div><div class="eyebrow">EVIDENCE & AUDIT</div><h1>证据与审计</h1><p>按用途查找事件，沿任务追踪过程，并独立核对审计完整性。</p></div>
      <div class="button-row"><button class="secondary" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新记录' }}</button><button class="primary" :disabled="verifying" @click="verify">{{ verifying ? '校验中…' : '完整校验审计链' }}</button></div>
    </div>
    <div class="evidence-tabs" role="group" aria-label="证据与审计内容分组">
      <button v-for="item in panes" :key="item.id" :class="{ active: pane === item.id }" :aria-current="pane === item.id ? 'page' : undefined" @click="pane = item.id"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></button>
    </div>

    <div v-if="pane === 'events'">
      <section class="panel">
        <div class="panel-heading"><div><h2>按事件用途浏览</h2><p class="muted scope-note">分类和筛选覆盖最近 {{ events.length }} 条已加载事件（最多 100 条），时间均为上海时区。</p></div><button class="text-button" :aria-pressed="category === 'all'" @click="category = 'all'">全部类别 · {{ events.length }}</button></div>
        <div class="category-grid">
          <button v-for="item in categories.filter(item => item.id !== 'other' || item.count > 0)" :key="item.id" class="category-card" :class="{ active: category === item.id }" :aria-pressed="category === item.id" @click="category = category === item.id ? 'all' : item.id">
            <span class="category-marker">{{ item.marker }}</span><span class="category-copy"><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><b>{{ item.count }}</b>
          </button>
        </div>
        <div class="evidence-filters">
          <label><span>关键词</span><input v-model="keyword" type="search" placeholder="搜索事件、路段、身份、编号或错误代码"></label>
          <label><span>关联任务</span><select v-model="taskId"><option value="">全部任务（含无关联任务的记录）</option><option v-for="id in tasks" :key="id" :value="id">{{ id }}</option></select></label>
          <label class="attention-filter"><input v-model="attentionOnly" type="checkbox"><span>仅失败 / 拒绝（{{ attentionCount }}）</span></label>
        </div>
        <div class="filter-summary"><span class="muted" aria-live="polite">{{ loading ? '正在读取最近事件…' : `显示 ${filtered.length} / ${events.length} 条` }}</span><button v-if="hasFilters" class="text-button" @click="resetFilters">清除全部筛选</button></div>
        <p v-if="loadError" class="evidence-error" role="alert">最近记录刷新失败{{ loaded ? '，当前仍显示上次加载的事件' : '' }}，请重试。</p>
      </section>
      <div v-if="!filtered.length && !loading" class="panel empty-state"><h3>{{ events.length ? '没有符合筛选条件的事件' : loadError ? '暂时无法读取事件' : '暂无审计事件' }}</h3><p class="muted">{{ events.length ? '调整类别、任务或关键词，即可继续查找。' : '刷新记录，或发起任务、导入车辆数据后查看。' }}</p></div>
      <section v-for="group in groups" :key="group.id" class="panel event-group">
        <div class="panel-heading"><div><h2>{{ group.label }} <span class="group-count">{{ group.events.length }}</span></h2><p class="muted scope-note">{{ group.description }} · 类别内按最新记录优先展示</p></div></div>
        <article v-for="event in group.events" :key="event.id" class="audit-event" :class="{ selected: selectedId === event.id }">
          <div class="event-heading"><div class="event-title"><span class="event-number">#{{ event.id }}</span><h3>{{ describeAuditEvent(event).title }}</h3><span class="event-status" :class="describeAuditEvent(event).outcome">{{ describeAuditEvent(event).status }}</span></div><time>{{ time(event.at) }}</time></div>
          <p class="event-summary">{{ describeAuditEvent(event).summary }}</p>
          <div class="event-context">
            <span>声明身份 <strong>{{ event.claimedIdentity ? actorLabel(event.claimedIdentity) : '未声明' }}</strong></span>
            <span>已验证身份 <strong>{{ event.verifiedIdentity ? actorLabel(event.verifiedIdentity) : '本条记录未提供' }}</strong></span>
          </div>
          <div class="event-actions"><button v-if="auditTaskId(event)" class="task-link" :title="`仅查看任务 ${auditTaskId(event)}`" @click="followTask(auditTaskId(event))">关联任务 · {{ auditTaskId(event) }}</button><span v-else class="muted">无关联任务编号</span><button class="text-button" @click="chooseEvent(event.id)">分析此事件 ↗</button></div>
          <details class="event-details" :open="expanded.has(event.id)" @toggle="toggleDetails($event, event.id)"><summary>查看事件详情与哈希凭据 <span>{{ event.kind }}</span></summary><div v-if="expanded.has(event.id)" class="event-detail-content"><ProtocolSection :section="{ title: '事件元数据', data: event.details }"/><ProtocolSection :section="{ title: '审计链原始凭据', data: event }"/></div></details>
        </article>
      </section>
    </div>

    <section v-else-if="pane === 'analysis'" class="panel">
      <div class="panel-heading"><div><h2>证据分析<span v-if="selectedId" class="group-count">#{{ selectedId }}</span></h2><p class="muted scope-note">先校验审计链，再分别给出事实、可能原因、建议与边界。</p></div><button class="secondary" :disabled="analyzing" @click="chooseEvent()">分析最近相关事件 ↗</button></div>
      <div v-if="selectedEvent" class="analysis-target"><strong>{{ describeAuditEvent(selectedEvent).title }}</strong><span>{{ time(selectedEvent.at) }} · {{ selectedEvent.kind }}</span><button v-if="auditTaskId(selectedEvent)" class="text-button" @click="followTask(auditTaskId(selectedEvent))">查看同一任务的事件 ↗</button></div>
      <p v-if="analyzing" class="muted" role="status">正在校验审计链并读取所选证据…</p>
      <p v-else-if="analysisError" class="evidence-error" role="alert">分析未完成，请查看错误提示并重试。较早的事件可能超出当前可分析范围。</p>
      <div v-else-if="analysis" class="analysis-grid"><section v-for="field in fields" :key="field.key"><h3>{{ field.label }}</h3><ul v-if="analysis[field.key].length"><li v-for="(item, index) in analysis[field.key]" :key="index"><MarkdownContent :content="item" /></li></ul><p v-else class="muted">本次未提供此项结论。</p></section></div>
      <p v-else class="muted">从“分类事件”选择一条记录，或分析最近相关事件。</p>
      <div v-if="analysis?.evidenceIds.length" class="analysis-references"><span class="muted">引用证据</span><button v-for="id in analysis.evidenceIds" :key="id" class="text-button" @click="chooseEvent(id)">#{{ id }}</button></div>
      <div class="button-row"><button class="secondary" @click="pane = 'events'">返回分类事件</button><button v-if="analysisError" class="secondary" :disabled="analyzing" @click="investigate(selectedId)">重试分析</button></div>
    </section>

    <div v-else class="integrity-sections">
      <section class="panel"><div class="panel-heading"><div><h2>审计链完整性</h2><p class="muted scope-note">校验完整审计链，不受当前事件筛选或最近 100 条的展示范围限制。</p></div></div>
        <div v-if="verification" class="verification-note" :class="{ invalid: !verification.valid }"><strong>{{ verification.valid ? '上次完整校验通过' : '上次完整校验失败' }}</strong><p>{{ verification.reason }}</p><small>校验时间：{{ time(verification.verifiedAt) }} · 当时共 {{ verification.count }} 条事件</small></div>
        <p v-else class="muted">尚无可用的完整校验结果。新增审计记录后，刷新记录并重新校验可获取最新状态。</p>
        <p class="muted">校验会核对事件顺序、前驱哈希、事件摘要及签名检查点。通过校验说明记录完整性符合检查条件，事件身份与行为结论仍须结合具体证据判断。</p>
        <button class="primary" :disabled="verifying" @click="verify">{{ verifying ? '正在校验…' : '重新完整校验' }}</button>
      </section>
      <section class="panel"><div class="panel-heading"><div><h2>签名检查点</h2><p class="muted scope-note">保留审计链长度、末端摘要与报告服务签名，方便后续比较。</p></div><button class="secondary" :disabled="checkpointBusy" @click="signCheckpoint">{{ checkpointBusy ? '读取中…' : '读取当前检查点' }}</button></div>
        <p class="muted">读取后可复制原文另存到受保护位置；本机目录本身依赖宿主机信任。</p><ProtocolSection v-if="checkpoint" :section="{ title: '已读取的签名检查点', data: checkpoint }"/>
      </section>
    </div>
  </div>
</template>

<style scoped>
.evidence-page { min-width:0; }
.evidence-tabs { display:flex; gap:8px; border-bottom:1px solid var(--line); margin-bottom:24px; padding-bottom:12px; }
.evidence-tabs button { display:flex; flex-direction:column; align-items:flex-start; gap:3px; padding:12px 22px; border-radius:9px; color:#718078; background:transparent; text-align:left; }
.evidence-tabs button.active { color:#167761; background:#edf7f2; }
.evidence-tabs button:hover { background:#f3f7f4; }
.evidence-tabs strong { font-size:14px; }.evidence-tabs span { font-size:11px; }
.scope-note { margin:6px 0 0; }
.category-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.category-card { display:flex; align-items:center; gap:12px; border:1px solid var(--line); border-radius:10px; padding:17px 14px; text-align:left; color:#3c5548; background:#fcfdfc; min-width:0; }
.category-card:hover { border-color:#a9cbbb; }.category-card.active { border-color:var(--teal); background:#eff8f4; box-shadow:inset 0 0 0 1px var(--teal); }
.category-marker { flex-shrink:0; color:#8ca398; font-size:11px; }.category-copy { display:flex; flex:1; flex-direction:column; min-width:0; }
.category-copy strong { font-size:14px; }.category-copy small { font-size:11px; color:var(--muted); }.category-card b { font-size:23px; font-weight:550; }
.evidence-filters { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto; gap:16px; margin-top:24px; align-items:end; }
.evidence-filters label:not(.attention-filter) { display:grid; gap:7px; font-size:12px; color:#647c6e; }
.attention-filter { display:flex; align-items:center; gap:8px; min-height:44px; font-size:12px; color:#7e6250; white-space:nowrap; }.attention-filter input { accent-color:var(--teal); }
.filter-summary { display:flex; gap:16px; align-items:center; margin-top:12px; }.evidence-error { color:#a34a3b; font-size:13px; }
.group-count { display:inline-block; margin-left:9px; font-size:12px; color:#6d8979; background:#f0f5f2; padding:2px 9px; border-radius:12px; font-weight:500; vertical-align:middle; }
.audit-event { padding:20px 0; border-top:1px solid #edf0ed; min-width:0; }.audit-event:first-of-type { border-top:0; padding-top:0; }.audit-event:last-child { padding-bottom:0; }.audit-event.selected { border-left:3px solid var(--teal); padding-left:16px; }
.event-heading { display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }.event-title { display:flex; align-items:center; gap:10px; min-width:0; flex-wrap:wrap; }.event-title h3 { margin:0; color:#344e40; }.event-number { color:#97a69b; font-size:12px; }.event-heading time { color:#8b988f; font-size:11px; }
.event-status { font-size:10px; background:#f1f4f2; color:#728579; padding:2px 8px; border-radius:10px; }.event-status.passed { color:#278263; background:#edf8f1; }.event-status.failed,.event-status.rejected { color:#aa573b; background:#fff2e9; }.event-status.cancelled { color:#797a83; background:#f2f2f5; }
.event-summary { color:#607366; font-size:13px; margin:10px 0; }.event-context { display:flex; gap:12px 28px; flex-wrap:wrap; font-size:11px; color:#92a095; }.event-context strong { color:#5e7968; margin-left:6px; font-weight:500; overflow-wrap:anywhere; }
.event-actions { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-top:9px; min-width:0; }.task-link { font-size:11px; text-align:left; background:#f5f8f6; color:#4b8069; border-radius:5px; padding:4px 8px; overflow-wrap:anywhere; min-width:0; }.event-actions>.text-button { white-space:nowrap; flex-shrink:0; }
.event-details { margin-top:8px; min-width:0; }.event-details summary { font-size:11px; color:#7b8d80; cursor:pointer; overflow-wrap:anywhere; }.event-details summary>span { color:#a0aaa3; margin-left:12px; }.event-detail-content { min-width:0; display:grid; gap:12px; margin-top:14px; }
.analysis-target { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:12px 16px; background:#f5f9f6; border-radius:8px; margin-bottom:18px; }.analysis-target strong { color:#456c55; font-size:13px; }.analysis-target span { color:#85968a; font-size:11px; }
.analysis-references { display:flex; gap:12px; align-items:center; flex-wrap:wrap; border-top:1px solid var(--line); padding-top:14px; margin-top:20px; }.verification-note p { margin:6px 0; }.verification-note small { font-size:11px; }.empty-state { text-align:center; padding:40px; }
</style>

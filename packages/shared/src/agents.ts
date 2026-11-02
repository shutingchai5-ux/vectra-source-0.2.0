import type { LlmAgentId } from "./identities";
import type { PublicModelSettings, PublicNode, Intent, TaskStatus } from "./index";
export const AGENT_TOOL_CATALOG = {
  delegate_statistics_planning: { label: "委派统计规划", purpose: "把实际车次、跨企业瓶颈或未来预约运力需求交给统计规划 Agent，接收校验并签名的方案。", access: "委派子智能体", intents: ["statistics"] },
  compute_statistics: { label: "执行联合统计", purpose: "按照批准方案执行三方隐私计算，并委派必需分析。缺少方案时先委派规划。", access: "执行受控计算", intents: ["statistics"] },
  delegate_analysis: { label: "委派证据分析", purpose: "把本轮批准结果和证据范围交给运营分析 Agent，接收签名分析产物。", access: "委派子智能体", intents: ["statistics", "investigation"] },
  verify_latest_report: { label: "验证报告签名", purpose: "验证当前对话最近一份报告的签名与任务绑定。", access: "只读校验", intents: ["verification"] },
  identity_status: { label: "查看登记身份", purpose: "读取实际登记的角色与公开身份状态。", access: "只读查询", intents: ["statistics", "investigation", "verification", "explain"] },
  get_park_overview: { label: "查看园区数据概况", purpose: "读取园区、固定入口、实际车次、预约与经营台账的公开目录和可统计字段，不返回单车明细或各方申报值。", access: "只读查询", intents: ["statistics", "investigation", "verification", "explain"] },
  search_memory: { label: "检索长期记忆", purpose: "按当前问题检索主智能体已启用且未过期的记忆，显示来源与记录时间。", access: "仅主智能体读取", intents: ["statistics", "investigation", "verification", "explain"] },
  remember_memory: { label: "记住用户要求", purpose: "仅在本轮用户明确要求记住时保存偏好、业务说明或操作经验；不保存密钥与原始车辆数据。", access: "仅主智能体按明确要求写入", intents: ["statistics", "investigation", "verification", "explain"] },
  search_task_history: { label: "查找历史任务", purpose: "检索已完成任务的批准结果、日期和来源，作为历史参考，不代替本轮实时计算。", access: "只读查询", intents: ["statistics", "investigation", "verification", "explain"] },
  submit_statistics_plan: { label: "提交统计方案", purpose: "提交实际车次、预约或经营台账的入口、时间、指标与粒度，后端校验并冻结数据和容量版本。", access: "提交受限产物", intents: ["statistics"] },
  query_events: { label: "查询本轮审计证据", purpose: "在审计链验证后读取本次调查范围内的事件与批准结果。", access: "只读查询", intents: ["statistics", "investigation"] },
  submit_analysis: { label: "提交分析结论", purpose: "提交事实、可能原因、建议、不确定性和已查询的证据编号。", access: "提交受限产物", intents: ["statistics", "investigation"] },
} as const;
export type AgentToolName = keyof typeof AGENT_TOOL_CATALOG;
export interface AgentDefinition { id: LlmAgentId; parentId?: LlmAgentId; summary: string; goals: string[]; boundaries: string[]; tools: AgentToolName[]; hasLongTermMemory: boolean }
export const AGENT_DEFINITIONS: Record<LlmAgentId, AgentDefinition> = {
  coordinator: { id: "coordinator", summary: "接收用户请求，管理长期记忆，将专项工作委派给子智能体，再复核与交付。", goals: ["理解用户目标并调用批准工具", "委派规划与分析，核对返回产物", "跨对话记住用户明确要求和已完成任务经验"], boundaries: ["不能让记忆覆盖本轮明确要求或安全规则", "不能绕过授权、执行任意代码或读取单车原始输入", "统计成功必须以真实工具产物为依据"], tools: ["delegate_statistics_planning", "compute_statistics", "delegate_analysis", "verify_latest_report", "identity_status", "get_park_overview", "search_memory", "remember_memory", "search_task_history"], hasLongTermMemory: true },
  planner: { id: "planner", parentId: "coordinator", summary: "接受主智能体委派，将自然语言查询转成可执行且受约束的统计方案。", goals: ["明确入口、时间、车次口径与指标", "忠实表达用户目标并提交结构化方案"], boundaries: ["只访问本次委派提供的公开上下文", "不执行隐私计算、不修改数据、不持有长期记忆", "不能扩大用户批准的范围"], tools: ["get_park_overview", "submit_statistics_plan"], hasLongTermMemory: false },
  analyst: { id: "analyst", parentId: "coordinator", summary: "接受主智能体委派，基于批准结果和真实证据提出可复核的运营分析。", goals: ["先查证据再提交结论", "区分事实、假设、人工建议和不确定性"], boundaries: ["只引用本次实际查询到的证据", "不把统计相关性当作因果，不声称已调整预约或资源", "不持有长期记忆，不读取单车原始输入"], tools: ["query_events", "identity_status", "submit_analysis"], hasLongTermMemory: false },
};
export const MEMORY_CATEGORIES = { preference: "用户偏好", business: "业务说明", procedure: "操作经验", episode: "历史任务" } as const;
export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
export interface AgentMemory { id: string; category: MemoryCategory; title: string; content: string; tags: string[]; enabled: boolean; pinned: boolean; source: "manual" | "user_request" | "task"; sourceTaskId?: string; sourceConversationId?: string; createdAt: number; updatedAt: number; expiresAt?: number; revision: number; usedCount: number; lastUsedAt?: number }
export interface MemorySettings { enabled: boolean; autoCapture: boolean; maxRecall: number }
export interface MemoryOverview { items: AgentMemory[]; total: number; settings: MemorySettings }
export interface AgentModelSettings extends PublicModelSettings { agentId: LlmAgentId; inherited: boolean; sourceAgentId: LlmAgentId }
export interface AgentRun { id: string; taskId: string; conversationId: string; agentId: LlmAgentId; parentAgentId?: LlmAgentId; purpose: string; status: TaskStatus; startedAt: number; finishedAt?: number; model: string; provider: string; errorCode?: string; resultDigest?: string }
export interface AgentDetail { identity: PublicNode; definition: AgentDefinition; model: AgentModelSettings; tools: Array<(typeof AGENT_TOOL_CATALOG)[AgentToolName] & { name: AgentToolName }>; memory?: { total: number; settings: MemorySettings }; runs: AgentRun[]; stats: { total: number; completed: number; failed: number; running: number }; allowedIntents: Intent[] }

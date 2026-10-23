export type ConversationPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const CONVERSATION_PHASES = [
  { id: 1, title: "请求受理", description: "登记消息、关联会话并等待执行。" },
  { id: 2, title: "查询规划", description: "明确查询范围，锁定时间、指标和数据版本。" },
  { id: 3, title: "签名授权", description: "检查查询间隔，为任务签名并向路侧安全网关申请授权。" },
  { id: 4, title: "节点准备", description: "启动计算节点，检查授权并解密各自的数据，准备本地统计量。" },
  { id: 5, title: "份额交换", description: "在加密连接中交换数据碎片，并计算各节点的汇总份额。" },
  { id: 6, title: "输出重构", description: "从汇总份额还原批准的统计结果，核对来源与任务范围。" },
  { id: 7, title: "证据分析", description: "核对真实证据，完成分析与公开解释。" },
  { id: 8, title: "报告交付", description: "核对完成条件，签名、验证并保存报告。" },
] as const;

interface PhaseStep { id?: string; parentId?: string; action: string; agent: string; kind: string; status?: string; phase?: ConversationPhase }
const actionPhases: Record<string, ConversationPhase> = {
  "锁定查询时间范围": 2, "批准统计方案": 2, "锁定任务计划": 2, submit_statistics_plan: 2,
  "生成并验证签名任务": 3, "预留隐私查询预算": 3, "封装签名授权请求": 3, "建立双向 TLS 会话": 3, "认证任务交换": 3, compute_statistics: 3,
  "任务与本地输入认证": 4, "生成秘密分享多项式": 4, "三方进程端点就绪": 4, "接收节点端点表": 4,
  "接收并确认输入份额": 5, "发送输入份额并核对回执": 5, "计算本地聚合份额": 5,
  "接收并确认聚合份额": 6, "发送聚合份额并确认": 6, "重构总和并签署批准输出": 6, "复核三方输出签名与绑定": 6, "协议完成": 6,
  "证据调查委托": 7, "证据分析完成": 7, "执行统计任务必需分析": 7, investigate: 7, query_events: 7, submit_analysis: 7,
  "任务产物与审计链校验": 8, "报告规范化与签名": 8, "报告签名与任务绑定复核": 8, "报告认证加密与回读": 8, "发布报告与完成对话": 8, verify_latest_report: 8,
};

function knownPhase(step: PhaseStep): ConversationPhase | undefined {
  if (Number.isInteger(step.phase) && step.phase! >= 1 && step.phase! <= 8) return step.phase;
  if (step.agent === "统计规划 Agent") return 2;
  if (step.agent === "信息安全分析 Agent") return 7;
  if (step.action === "三方秘密分享计算") return step.status === "running" ? 4 : 6;
  return actionPhases[step.action] ?? (step.kind === "report" ? 8 : undefined);
}

// Historical steps are classified for display only; signed or persisted history is never rewritten.
export function resolveStepPhase(step: PhaseStep, steps: readonly PhaseStep[] = []): ConversationPhase {
  const known = knownPhase(step); if (known) return known;
  const index = step.id ? steps.findIndex(item => item.id === step.id) : -1;
  const earlier = steps.slice(0, index < 0 ? steps.length : index);
  const parent = earlier.find(item => item.id === step.parentId);
  if (parent) { const phase = knownPhase(parent); if (phase) return phase; }
  const previous = [...earlier].reverse().map(knownPhase).find(Boolean);
  if (step.kind === "model") return previous && previous >= 6 ? 7 : 3;
  return previous ?? 3;
}

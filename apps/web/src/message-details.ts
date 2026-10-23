import type { StatisticsQuery, Step } from "@vectra/shared";
import { securityNames } from "./security-language";

export interface SecurityProtocol { id: string; name: string; purpose: string }
const protocols = {
  tls: { id: "tls", name: `${securityNames.mTLS} / ${securityNames.TLS} 1.3`, purpose: "先确认通信双方都是登记节点，再加密传输，降低冒充、窃听和途中改动消息的风险。" },
  https: { id: "https", name: securityNames.HTTPS, purpose: "加密你与模型服务之间的请求和回复，并核对模型服务的证书身份。" },
  certificate: { id: "certificate", name: securityNames["X.509"], purpose: "像核对身份证件一样，检查证书来源、有效期与登记指纹，确认公钥对应的节点身份。" },
  signature: { id: "signature", name: securityNames.Ed25519, purpose: "为任务或结果附上可核对的数字签名，帮助接收方确认签署来源，并发现签署后的内容改动。" },
  canonical: { id: "canonical", name: securityNames.JCS, purpose: "先统一内容的表示格式，使签署方和验证方核对同一份内容，避免字段排列差异影响验签。" },
  digest: { id: "digest", name: securityNames["SHA-256"], purpose: "为内容生成固定长度的“指纹”，用来核对请求、结果和前后审计记录是否一致；摘要本身不加密内容。" },
  encryption: { id: "encryption", name: securityNames["AES-256-GCM"], purpose: "加密保存在本机的数据，并在读取时检查内容改动或任务错配，保护文件的机密性与完整性。" },
  sharing: { id: "sharing", name: securityNames.Shamir, purpose: "把统计量拆成随机数据碎片，让节点在份额上协作计算，再还原批准的总量，减少协议中直接交换完整输入。" },
} satisfies Record<string, SecurityProtocol>;
type ProtocolId = keyof typeof protocols;
const byAction: Record<string, readonly ProtocolId[]> = {
  "生成并验证签名任务": ["canonical", "signature", "digest"],
  "封装签名授权请求": ["canonical", "signature"],
  "建立双向 TLS 会话": ["tls", "certificate"],
  "认证任务交换": ["tls", "signature", "digest"],
  "三方秘密分享计算": ["tls", "sharing", "signature"],
  "任务与本地输入认证": ["signature", "encryption"],
  "生成秘密分享多项式": ["sharing"],
  "接收并确认输入份额": ["tls", "sharing"],
  "发送输入份额并核对回执": ["tls", "sharing"],
  "计算本地聚合份额": ["sharing"],
  "接收并确认聚合份额": ["tls", "sharing"],
  "发送聚合份额并确认": ["tls", "sharing"],
  "重构总和并签署批准输出": ["sharing", "canonical", "signature"],
  "复核三方输出签名与绑定": ["signature", "canonical"],
  "证据调查委托": ["digest", "signature"],
  "证据分析完成": ["digest", "signature"],
  "任务产物与审计链校验": ["digest", "signature"],
  "报告规范化与签名": ["canonical", "signature"],
  "报告签名与任务绑定复核": ["signature", "digest"],
  "报告认证加密与回读": ["encryption"],
  "发布报告与完成对话": ["digest", "signature"],
  compute_statistics: ["tls", "sharing", "signature"], investigate: ["digest", "signature"],
  query_events: ["digest", "signature"], verify_latest_report: ["signature", "digest"], identity_status: ["certificate"],
};
export const reportProtocols = [protocols.signature, protocols.encryption];
export const auditProtocols = [protocols.digest, protocols.signature];

export function securityProtocolsForStep(step: Pick<Step, "kind" | "action" | "protocol">): SecurityProtocol[] {
  // Model prose cannot claim a protocol ran. Only execution actions and transport metadata select labels.
  if (step.kind === "model") return step.protocol?.startsWith("HTTPS /") ? [protocols.https] : [];
  return (byAction[step.action] ?? []).map(id => protocols[id]);
}

export interface MathExplanation { title: string; latex: string; meaning: string }
export function mathematicsForStep(step: Step, query?: StatisticsQuery): MathExplanation[] {
  if (step.kind === "model") return [];
  switch (step.action) {
    case "任务与本地输入认证": return [{ title: "批准的采样区间", latex: String.raw`t_{\mathrm{start}}\le t_r<t_{\mathrm{end}}`, meaning: "只使用批准路段中含起点、不含终点的采样记录。" }];
    case "生成秘密分享多项式": return [
      { title: "把可含小数的数值转为整数", latex: String.raw`z_r=\operatorname{round}(10^4 u_r)`, meaning: "u 是所用字段的原始数值，例如速度、里程或能耗；放大一万倍再取整。计数项不需要这种放大。" },
      { title: "为每项统计量生成随机份额", latex: String.raw`f_{i,k}(x)=(s_{i,k}+a_{i,k}x)\bmod p,\qquad x\in\{1,2,3\},\quad p=2^{127}-1`, meaning: "i 表示提供输入的节点，k 表示第几项统计量；s 是本地统计量，a 是本次独立随机数，x 对应接收份额的节点。" },
    ];
    case "计算本地聚合份额": return [{ title: "在同一横坐标聚合份额", latex: String.raw`G_k(j)=\left(\sum_{i=1}^{3}f_{i,k}(j)\right)\bmod p`, meaning: "节点 j 将三个来源在相同分量 k 上的份额相加，得到一个聚合份额。" }];
    case "发送输入份额并核对回执": case "接收并确认输入份额": return [{ title: "交付给节点 j 的份额向量", latex: String.raw`\boldsymbol{F}_i(j)=\bigl(f_{i,1}(j),\ldots,f_{i,d}(j)\bigr)`, meaning: "每条份额报文携带 d 个分量；j 是接收节点的横坐标。" }];
    case "重构总和并签署批准输出": return [
      { title: "三节点重构", latex: String.raw`T_k=\bigl(3G_k(1)-3G_k(2)+G_k(3)\bigr)\bmod p`, meaning: "逐分量重构批准的充分统计量；本实现要求三个节点全部完成。" },
      ...metricMathematics(query),
    ];
    default: return [];
  }
}

function metricMathematics(query?: StatisticsQuery): MathExplanation[] {
  const formulas: Record<string, { latex: string; meaning: string }> = {
    count: { latex: String.raw`N=\sum_{i=1}^{3}n_i`, meaning: "相加各节点满足条件的有效样本数。" },
    vehicle_count: { latex: String.raw`C=\sum_{i=1}^{3}\left|\operatorname{unique}(V_i)\right|`, meaning: "各节点内按车辆编号去重后相加；同一车辆固定归属同一节点。" },
    sum: { latex: String.raw`S_{\mathrm{value}}=\frac{S}{Q},\qquad Q=10^4`, meaning: "S 为重构后的定点总和，除以编码倍率恢复业务单位。" },
    mean: { latex: String.raw`\bar v=\frac{S}{QN},\qquad Q=10^4,\quad N>0`, meaning: "用全部有效样本总和除以样本数；分母为零时返回无数据。" },
    variance: { latex: String.raw`\sigma^2=\max\left(0,\frac{S_2}{Q^2N}-\left(\frac{S}{QN}\right)^2\right)`, meaning: "利用编码后的平方和、总和与有效样本数，计算总体方差。" },
    stddev: { latex: String.raw`\sigma=\sqrt{\max\left(0,\frac{S_2}{Q^2N}-\left(\frac{S}{QN}\right)^2\right)}`, meaning: "总体方差开平方得到标准差；N 为有效样本数，Q 为定点倍率。" },
    ratio: { latex: String.raw`P=\frac{N_{\mathrm{match}}}{N_{\mathrm{valid}}}\times100\%`, meaning: "符合条件的样本数占具有完整所需字段的候选样本数的百分比。" },
    ratio_of_sums: { latex: String.raw`R=\frac{S}{D}\times m`, meaning: "S、D 为分子与分母字段的编码总和，倍率 m 为批准的 1 或 100。" },
  };
  return (query?.metrics ?? []).map(metric => ({ title: metric.label, ...formulas[metric.operation] }));
}

// Keep original report/protocol data intact; adapt known historical expressions at render time.
export function formatProtocolMathematics(text: string): string {
  return text.replace("G(x)=Σ f_i(x) mod p", String.raw`$G_k(x)=\sum_{i=1}^{3}f_{i,k}(x)\bmod p$`)
    .replace("(3G(1)-3G(2)+G(3)) mod p", String.raw`$\bigl(3G_k(1)-3G_k(2)+G_k(3)\bigr)\bmod p$`)
    .replace(/\bf\(([123])\)/g, (_match, x: string) => `$\\boldsymbol{F}_i(${x})$`);
}
export const hasMathematics = (text: string) => /\\[([]|\$\$|\$[^$\n]+\$/.test(text);

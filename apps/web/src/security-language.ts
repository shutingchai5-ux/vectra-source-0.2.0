import type MarkdownIt from "markdown-it";

// Names follow RFC 8446, RFC 8785, RFC 8032 and NIST SP 800-38D.
// Ed25519, X.509 and Shamir are algorithm/standard names, not invented acronym expansions.
export const securityNames: Record<string, string> = {
  "AES-256-GCM": "AES-256-GCM（Advanced Encryption Standard, 256-bit, Galois/Counter Mode，256 位高级加密标准的伽罗瓦/计数器模式）",
  "AES-256": "AES-256（Advanced Encryption Standard, 256-bit，256 位高级加密标准）",
  AES: "AES（Advanced Encryption Standard，高级加密标准）",
  GCM: "GCM（Galois/Counter Mode，伽罗瓦/计数器模式）",
  "SHA-256": "SHA-256（Secure Hash Algorithm, 256-bit，256 位安全散列算法）",
  mTLS: "mTLS（Mutual Transport Layer Security，双向传输层安全认证）",
  TLS: "TLS（Transport Layer Security，传输层安全协议）",
  HTTPS: "HTTPS（Hypertext Transfer Protocol Secure，安全超文本传输协议）",
  HTTP: "HTTP（Hypertext Transfer Protocol，超文本传输协议）",
  JCS: "JCS（JSON Canonicalization Scheme，JSON 规范化方案）",
  MPC: "MPC（Multi-Party Computation，多方计算）",
  RSU: "RSU（Roadside Unit，路侧单元）",
  LLM: "LLM（Large Language Model，大语言模型）",
  Ed25519: "Ed25519（Edwards-curve Digital Signature Algorithm，爱德华兹曲线数字签名算法的 edwards25519 实例）",
  "X.509": "X.509（公钥证书标准）",
  Shamir: "Shamir（沙米尔秘密分享方案）",
  AAD: "AAD（Additional Authenticated Data，附加认证数据）",
  CA: "CA（Certificate Authority，证书颁发机构）",
  PKI: "PKI（Public Key Infrastructure，公钥基础设施）",
  "PKCS#8": "PKCS#8（Public-Key Cryptography Standards #8，公钥密码标准第 8 号私钥格式）",
  PEM: "PEM（Privacy-Enhanced Mail，隐私增强邮件编码格式）",
};
const terms = Object.keys(securityNames).sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const termPattern = new RegExp(`(?<![A-Za-z0-9_/-])(${terms.join("|")})(?![A-Za-z0-9_-])`, "g");
const serviceNames: Record<string, string> = {
  compute_statistics: "执行批准的车辆统计", investigate: "调查本轮证据", query_events: "查询实际审计事件",
  submit_analysis: "提交并检查分析结论", verify_latest_report: "验证当前对话最近的报告", identity_status: "查看参与者登记身份", submit_statistics_plan: "提交并检查统计方案",
};
const servicePattern = new RegExp(`(?<![A-Za-z0-9_/-])(${Object.keys(serviceNames).join("|")})(?![A-Za-z0-9_/-])`, "g");
const proseTerms: Record<string, string> = { "执行契约": "本轮交付要求", "工具调用": "服务执行请求", "工具产物": "服务实际返回的结果", "受控统计语言": "系统支持的统计规则", "统计向量": "按固定顺序排列的统计量" };
export function userFacingProse(text: string): string {
  let result = text.replace(servicePattern, name => serviceNames[name]);
  for (const [technical, readable] of Object.entries(proseTerms)) result = result.replaceAll(technical, readable);
  return result;
}

export function expandSecurityNames(text: string, followingText = ""): string {
  return text.replace(termPattern, (name: string, _term: string, offset: number) => {
    const after = text.slice(offset + name.length) + followingText;
    return /^(?:\s+\d+(?:\.\d+)*)?\s*[（(]/.test(after) ? name : securityNames[name];
  });
}

// Adapt human-readable prose only. Signed records, links, code, formulas and user input stay intact.
export function installSecurityLanguage(md: InstanceType<typeof MarkdownIt>) {
  md.core.ruler.after("linkify", "security-language", state => {
    if (!state.env?.explainProtocols) return;
    for (const block of state.tokens) {
      const children = block.children;
      if (!children) continue;
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (token.type === "link_open") linkDepth++;
        if (token.type === "link_close") linkDepth--;
        if (token.type !== "text" || linkDepth) continue;
        let following = "";
        for (let next = index + 1; next < children.length; next++) {
          if (["strong_close", "em_close", "s_close"].includes(children[next].type)) continue;
          if (children[next].type === "text") following = children[next].content;
          break;
        }
        token.content = userFacingProse(expandSecurityNames(token.content, following));
      }
    }
  });
}

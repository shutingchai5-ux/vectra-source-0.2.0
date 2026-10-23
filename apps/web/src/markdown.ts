import MarkdownIt from "markdown-it";
import { installMath } from "./math";
import { installSecurityLanguage } from "./security-language";
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
installMath(md);
installSecurityLanguage(md);
md.renderer.rules.link_open = (tokens, index, options, _env, self) => { tokens[index].attrSet("target", "_blank"); tokens[index].attrSet("rel", "noopener noreferrer"); return self.renderToken(tokens, index, options); };
md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], url = String(token.attrGet("src") || ""), label = md.utils.escapeHtml(token.content || "查看图片");
  return md.validateLink(url) ? `<a href="${md.utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : label;
};
for (const type of ["th_open", "td_open"]) md.renderer.rules[type] = (tokens, index, options, _env, self) => {
  const token = tokens[index], align = String(token.attrGet("style") || "").match(/^text-align:(left|center|right)$/)?.[1];
  if (align) { token.attrs = token.attrs?.filter(([key]) => key !== "style") ?? []; token.attrJoin("class", `align-${align}`); }
  return self.renderToken(tokens, index, options);
};
export const renderMarkdown = (content: string, explainProtocols = false) => md.render(content, { explainProtocols });

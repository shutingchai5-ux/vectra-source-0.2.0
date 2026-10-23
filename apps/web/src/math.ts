import type MarkdownIt from "markdown-it";
import katex from "katex";

const escaped = (source: string, at: number) => {
  let count = 0; while (at > 0 && source[--at] === "\\") count++;
  return count % 2 === 1;
};

export function installMath(md: InstanceType<typeof MarkdownIt>) {
  const render = (source: string, displayMode: boolean) => {
    try {
      if (source.length > 8000) throw new Error("Formula too long");
      return katex.renderToString(source, { displayMode, output: "htmlAndMathml", throwOnError: true,
        trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20, macros: {} });
    } catch {
      return `<span class="math-error" role="note">公式暂无法排版：<code>${md.utils.escapeHtml(source)}</code></span>`;
    }
  };
  md.inline.ruler.before("escape", "math", (state, silent) => {
    const start = state.pos, source = state.src;
    const open = source.startsWith("\\(", start) ? "\\(" : source.startsWith("\\[", start) ? "\\[" : source.startsWith("$$", start) ? "$$" : source[start] === "$" ? "$" : "";
    if (!open || escaped(source, start)) return false;
    const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open;
    const from = start + open.length;
    if (open === "$" && /\s/.test(source[from] ?? " ")) return false;
    let end = source.indexOf(close, from);
    while (end >= 0 && (escaped(source, end) || open === "$" && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? "")))) end = source.indexOf(close, end + close.length);
    if (end < 0 || end === from || open === "$" && source.slice(from, end).includes("\n")) return false;
    if (!silent) {
      const token = state.push(open === "$" || open === "\\(" ? "math_inline" : "math_display", "", 0);
      token.content = source.slice(from, end).trim();
    }
    state.pos = end + close.length; return true;
  });
  md.block.ruler.before("fence", "math", (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const open = line.startsWith("$$") ? "$$" : line.startsWith("\\[") ? "\\[" : "";
    if (!open) return false;
    const close = open === "$$" ? "$$" : "\\]";
    let last = startLine, content = line.slice(open.length), end = content.indexOf(close);
    while (end < 0 && ++last < endLine) {
      const next = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]);
      content += "\n" + next; end = content.indexOf(close);
    }
    if (end < 0 || content.slice(end + close.length).trim()) return false;
    if (silent) return true;
    const token = state.push("math_block", "", 0); token.block = true;
    token.content = content.slice(0, end).trim(); token.map = [startLine, last + 1];
    state.line = last + 1; return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, index) => render(tokens[index].content, false);
  md.renderer.rules.math_display = (tokens, index) => `<span class="math-block">${render(tokens[index].content, true)}</span>`;
  md.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${render(tokens[index].content, true)}</div>\n`;
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, self) => ["math", "latex", "tex"].includes(tokens[index].info.trim())
    ? `<div class="math-block">${render(tokens[index].content.trim(), true)}</div>\n` : fence(tokens, index, options, env, self);
}

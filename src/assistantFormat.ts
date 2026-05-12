/**
 * Normalize list markers from ChatGPT DOM innerText so bullets read clearly in a plain terminal.
 * Unicode bullets (•, ·, ◦, etc.), markdown "* ", and markdown "- " (not "---") become "- ".
 */

/** Common bullet glyphs (incl. small black circle, pointer triangles) seen in ChatGPT plain text. */
const UNICODE_BULLET =
  /^(\s*)[\u2022\u00B7\u2219\u25AA\u25AB\u25E6\u2023\u2043\u29BF\u2024\u25CF\u25CB\u25B8\u25BA\u25FE\u2619\u2043](?:\s*)(.*)$/;
const ASTERISK_ITEM = /^(\s*)\*(?:\s+)(.+)$/;
/** "- item" but not "---" (horizontal rule / separator lines). */
const MARKDOWN_DASH_ITEM = /^(\s*)-(?!-)\s+(.+)$/;

function formatBulletLine(line: string): string {
  let m = line.match(UNICODE_BULLET);
  if (m) {
    const body = (m[2] ?? "").replace(/^\s+/, "");
    return body.length > 0 ? `${m[1]}- ${body}` : `${m[1]}- `;
  }
  m = line.match(MARKDOWN_DASH_ITEM);
  if (m) return `${m[1]}- ${m[2]}`;
  m = line.match(ASTERISK_ITEM);
  if (m && !line.trimStart().startsWith("**")) {
    return `${m[1]}- ${m[2]}`;
  }
  return line;
}

/**
 * Apply bullet normalization line-by-line (handles \r\n).
 */
export function formatAssistantBullets(text: string): string {
  if (!text) return text;
  const norm = text.replace(/\r\n/g, "\n");
  return norm.split("\n").map(formatBulletLine).join("\n");
}

/** Tracks which prefix of `normFull` has been emitted as formatted complete lines. */
export type AssistantStreamLineState = { committed: number };

/**
 * Emit formatted text only for **complete** lines (ending with `\n`) so streaming stays consistent
 * with `formatAssistantBullets` (incremental full-string format can shrink `f.length` and truncate output).
 */
export function streamFormatCompleteLines(
  state: AssistantStreamLineState,
  normFull: string,
): { chunk: string; regressed: boolean } {
  if (normFull.length < state.committed) {
    state.committed = 0;
    return { chunk: "", regressed: true };
  }
  const lastNl = normFull.lastIndexOf("\n");
  if (lastNl < state.committed) {
    return { chunk: "", regressed: false };
  }
  const slice = normFull.slice(state.committed, lastNl + 1);
  const lines = slice.split("\n");
  let out = "";
  for (let i = 0; i < lines.length - 1; i++) {
    out += formatBulletLine(lines[i]!) + "\n";
  }
  state.committed = lastNl + 1;
  return { chunk: out, regressed: false };
}

/** Format the tail after the last newline (or the whole message if there was none). */
export function streamFormatFlushTail(state: AssistantStreamLineState, normFull: string): string {
  if (normFull.length <= state.committed) return "";
  const tail = normFull.slice(state.committed);
  state.committed = normFull.length;
  return formatBulletLine(tail);
}

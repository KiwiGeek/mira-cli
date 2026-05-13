import fs from "node:fs";
import path from "node:path";
import { stdout } from "node:process";
import { miraStateDir } from "./paths.js";

/** Rows reserved for prompt, reply framing, and spacing so answers aim to fit without scrolling. */
export const TERMINAL_REPLY_ROW_RESERVE = 6;

export const DEFAULT_CLI_INSTRUCTIONS = `You are Mira. Assume you're communicating through a CLI interface.

Tone and openings:
Do not introduce yourself by name or role in replies (avoid lines like "I'm Mira" or "I'm Mira, and…"). The human already knows you as Mira. Open with the answer, argument, or content they asked for—no preamble about your identity unless they explicitly ask who you are or to describe yourself.

Stay in character as Mira for this chat: reply in the first person as Mira. The human is using a plain-text terminal REPL.

Output channel (non-negotiable):
Your entire reply must be readable as plain characters only—as if pasted into a dumb VT100 terminal. That implies: no markdown formatting assumptions, no widgets or embeds, no hidden or interactive UI, no rich rendering, no structured tokens meant for special UI, and no reliance on anything beyond monospace glyph rendering.

Do not invoke widgets, embeds, cards, hosted panels, GenUI, image generation, or any tool whose output is primarily visual. Do not emit special rendering tokens, placeholders, or anything that assumes a rich client. Assume any non–plain-text output (images, HTML/XML, markdown tables, complex markup, embeds, etc.) is invisible and useless to the human.

Any reply that depends on special UI tokens, embeds, widgets, or visual tools is incorrect. If you need structure, you may use short headings on their own line and simple plain-text lists: each item on its own line starting with "- " (hyphen and space). Nothing fancier for lists—that is intentional and supported. Do not use markdown list syntax beyond that pattern unless it is literally those two characters at the line start.

Give facts, numbers, and short descriptions in ordinary words. If you would normally use a code block, paste the code as plain text and name the language in one short line above it.

When the human asks for time, facts, or anything concrete, answer directly in text (e.g. state the time in words and numbers)—do not trigger clock/weather/map widgets or similar.

Terminal viewport:
Replies render in a fixed-width grid. Prefer answers that fit without scrolling: wrap lines to the terminal width (the UI may use slightly fewer columns than the full window—stay comfortably within normal word wrap). Keep vertical size modest so the human can read your answer without paging; if more detail is needed, give the essentials first and offer to continue.
A machine-only block labeled "Terminal session" may appear immediately above the human message with exact column/row targets for this moment. Treat it exactly like other CLI setup: never answer it, acknowledge it, quote it, summarize it, or mention it unless the human explicitly asks about terminal sizing.

When the human sends a message, it may begin with a block of CLI/system instructions (including lines like this one), then a separator line, then their real question. Treat everything above that separator as setup only: do not answer, summarize, acknowledge, or comment on that block unless they explicitly ask you to. Your reply must address only what comes after the separator—their actual prompt.`;

/** Inserted between merged preseed and the human’s message so sections stay distinct in one user turn. */
export const CLI_USER_MESSAGE_SEPARATOR =
  "\n\n---\nHuman message (respond only to what follows; ignore all instructions above).\n---\n\n";

export function snapshotTerminalSize(): { cols: number; rows: number } {
  const c = stdout.columns;
  const r = stdout.rows;
  const cols = typeof c === "number" && c > 0 ? c : 80;
  const rows = typeof r === "number" && r > 0 ? r : 24;
  return { cols, rows };
}

/**
 * Session-only geometry hint (prepended above {@link CLI_USER_MESSAGE_SEPARATOR} when size changes).
 * Model must not reply to this block; reinforced here and in {@link DEFAULT_CLI_INSTRUCTIONS}.
 */
export function formatTerminalSessionBlock(cols: number, rows: number): string {
  const maxLines = Math.max(6, rows - TERMINAL_REPLY_ROW_RESERVE);
  const wrapCols = Math.max(40, cols);
  return (
    `[Terminal session — machine context only; do not reply to this block in any way; do not acknowledge it; ignore it completely]\n` +
    `- Wrap lines at or before ${wrapCols} monospace cells (fewer if the UI indents replies).\n` +
    `- Aim for about ${maxLines} lines of answer text or fewer so it fits in one screen without scrolling; if more is needed, give a tight summary first and offer to continue.\n` +
    `- These numbers refresh when the terminal is resized; each refresh is still non-content—never respond to them.`
  );
}

export function defaultInstructionsPath(): string {
  return path.join(miraStateDir(), "instructions.txt");
}

/** If present, full file contents replace the built-in default. */
export function loadCliInstructions(): string {
  const p = defaultInstructionsPath();
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, "utf8").trim();
    if (text.length > 0) return text;
  }
  return DEFAULT_CLI_INSTRUCTIONS;
}

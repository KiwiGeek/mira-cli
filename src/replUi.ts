import { stdout } from "node:process";

function colorOn(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== "") return true;
  return stdout.isTTY === true;
}

const on = colorOn();

const INDENT = "  ";
/** Same visual width for `you` / `mira` labels (aligns prompt + reply headers). */
const LABEL_COL = 4;

/** Apply SGR codes (without \x1b[ prefix). */
function s(s: string, code: string): string {
  return on ? `\x1b[${code}m${s}\x1b[0m` : s;
}

/** Terminal width in cells (fallback when not a TTY). */
function termCols(): number {
  const c = stdout.columns;
  return Math.max(40, typeof c === "number" && c > 0 ? c : 80);
}

/** Length of string as displayed (strip ANSI). */
function visibleLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Word-wrap one line of plain text to a maximum character width (hard-break long tokens). */
function wrapParagraphWords(line: string, width: number): string[] {
  if (width < 1) return line.length > 0 ? [line] : [];
  const t = line.trimEnd();
  if (!t) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const tryLine = cur ? `${cur} ${w}` : w;
    if (tryLine.length <= width) {
      cur = tryLine;
    } else {
      if (cur) out.push(cur);
      if (w.length <= width) cur = w;
      else {
        out.push(...chunkString(w, width));
        cur = "";
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function chunkString(w: string, width: number): string[] {
  const ch: string[] = [];
  for (let i = 0; i < w.length; i += width) ch.push(w.slice(i, i + width));
  return ch;
}

/**
 * Split on `\n` like `printUserMessageBubble` did: empty segments become a single blank visual row.
 * Non-empty rows are word-wrapped to `width`.
 */
function wrapMessageByNewlines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const row of text.replace(/\r\n/g, "\n").split("\n")) {
    if (row === "") out.push("");
    else out.push(...wrapParagraphWords(row, width));
  }
  return out;
}

function userBubbleMinOuter(): number {
  const tl = on ? s("╭", "90") : "╭";
  const tr = on ? s("╮", "90") : "╮";
  const dash2 = on ? s("──", "90") : "──";
  const label = on ? ` ${s("You", "1;32")} ` : " You ";
  return visibleLen(tl) + visibleLen(dash2) + visibleLen(label) + visibleLen(dash2) + visibleLen(tr);
}

function userBubbleTopRule(outer: number): string {
  const tl = on ? s("╭", "90") : "╭";
  const tr = on ? s("╮", "90") : "╮";
  const dash2 = on ? s("──", "90") : "──";
  const label = on ? ` ${s("You", "1;32")} ` : " You ";
  const rest = outer - visibleLen(tl) - visibleLen(tr) - visibleLen(label) - visibleLen(dash2);
  const fill = on ? s("─".repeat(Math.max(0, rest)), "90") : "─".repeat(Math.max(0, rest));
  return tl + fill + label + dash2 + tr;
}

function userBubbleBottomRule(outer: number): string {
  const bl = on ? s("╰", "90") : "╰";
  const br = on ? s("╯", "90") : "╯";
  const mid = outer - visibleLen(bl) - visibleLen(br);
  const fill = on ? s("─".repeat(Math.max(0, mid)), "90") : "─".repeat(Math.max(0, mid));
  return bl + fill + br;
}

/** Minimum outer width for Mira caption row `╭── Mira ─…╮`. */
function miraBubbleMinOuter(): number {
  const tl = on ? s("╭", "90") : "╭";
  const tr = on ? s("╮", "90") : "╮";
  const dash2 = on ? s("──", "90") : "──";
  const label = ` ${on ? s("Mira", "1;36") : "Mira"} `;
  return visibleLen(tl) + visibleLen(dash2) + visibleLen(label) + visibleLen(tr);
}

function miraBubbleTopRule(outer: number): string {
  const tl = on ? s("╭", "90") : "╭";
  const tr = on ? s("╮", "90") : "╮";
  const dash2 = on ? s("──", "90") : "──";
  const label = ` ${on ? s("Mira", "1;36") : "Mira"} `;
  let built = tl + dash2 + label;
  const rest = outer - visibleLen(tl) - visibleLen(dash2) - visibleLen(label) - visibleLen(tr);
  const fill = on ? s("─".repeat(Math.max(0, rest)), "90") : "─".repeat(Math.max(0, rest));
  return built + fill + tr;
}

export const ui = {
  on,

  dim: (t: string) => s(t, "2"),
  bold: (t: string) => s(t, "1"),
  cyan: (t: string) => s(t, "36"),
  green: (t: string) => s(t, "32"),
  yellow: (t: string) => s(t, "33"),
  red: (t: string) => s(t, "31"),
  gray: (t: string) => s(t, "90"),
  magenta: (t: string) => s(t, "35"),

  /** Reset SGR (e.g. after readline or Ctrl+C). */
  userInputEnd: (): string => (on ? "\x1b[0m" : ""),

  /**
   * Primary prompt (TTY multiline reader); `miraReplyBegin` uses the same label column so columns line up.
   */
  promptYou: (): string => {
    const lab = "you ".padEnd(LABEL_COL, " ");
    return on ? `${INDENT}${s(lab, "1;36")}${s("›", "2")} ` : `${INDENT}${lab}› `;
  },

  /**
   * After the inline spinner stops: clear the `mira ✦` row and the blank row under the user bubble, so the
   * cursor sits on that blank row for the reply box top. No-op when not a TTY.
   */
  prepForReplyBoxOpen: (): void => {
    if (!stdout.isTTY) return;
    process.stdout.write("\r\x1b[2K");
    process.stdout.write("\x1b[1A\r\x1b[2K");
  },

  line: (): void => {
    console.log(ui.gray(" ─────────────────────────────────────────────────────"));
  },

  /** One-time header after the session is ready. */
  banner: (opts: { resumedChat?: boolean }): void => {
    ui.line();
    const right = opts.resumedChat ? "Resumed chat" : "New session";
    console.log(`  ${ui.bold("Mira")}  ${ui.gray("·")}  terminal REPL for ChatGPT  ${ui.dim(right)}`);
    ui.line();
    const vibe = opts.resumedChat
      ? "Threads restored. Still the same deal: sharp answers, occasional grin."
      : "Clever when it helps, straight when it matters. I won't waste your tab width.";
    console.log(`  ${ui.dim(vibe)}`);
    console.log(
      `  ${ui.gray("/help")}${ui.dim("  ·  ")}${ui.gray("Shift+Enter")}${ui.dim(" newline  ·  ")}${ui.gray("/quit")}${ui.dim(" exit (archives by default)")}`,
    );
    console.log(
      `  ${ui.dim("Piped / non-TTY: end a line with ")}${ui.gray("\\")}${ui.dim(" + Enter to continue.")}`,
    );
    console.log(
      `  ${ui.dim("Wait for Mira’s reply before the next message; ")}${ui.gray("/commands")}${ui.dim(" work between turns.")}`,
    );
    console.log();
  },

  /** One-shot user bubble: right-aligned, ≤85% width, both borders; inner text color vs border. */
  printUserMessageBubble: (message: string): void => {
    const norm = message.replace(/\r\n/g, "\n");
    if (!norm.trim()) return;
    const cols = termCols();
    const maxOuter = Math.max(userBubbleMinOuter(), Math.floor(cols * 0.85));
    let outer = maxOuter;
    let wrapped: string[] = [];
    for (let i = 0; i < 8; i++) {
      const innerW = Math.max(2, outer - 4);
      wrapped = wrapMessageByNewlines(norm, innerW);
      const longest = wrapped.reduce((m, l) => Math.max(m, l.length), 1);
      const nextOuter = Math.max(userBubbleMinOuter(), Math.min(maxOuter, longest + 4));
      if (nextOuter === outer) break;
      outer = nextOuter;
    }
    const innerW = outer - 4;
    const padCol = Math.max(0, cols - outer);

    const flushRow = (row: string): void => {
      const padded = row.padEnd(innerW);
      const interior = on
        ? `${s("│", "90")} ${s(padded, "97")} ${s("│", "90")}`
        : `│ ${padded} │`;
      process.stdout.write(" ".repeat(padCol) + interior + "\n");
    };

    process.stdout.write(" ".repeat(padCol) + userBubbleTopRule(outer) + "\n");
    for (const line of wrapped) flushRow(line);
    process.stdout.write(" ".repeat(padCol) + userBubbleBottomRule(outer) + "\n");
  },

  /**
   * Streaming Mira reply: provisional box at ≤85% width while streaming; on close (TTY), cursor is moved back
   * and the same text is redrawn shrink-wrapped to match output like the user bubble.
   */
  createReplyBoxWriter: (): {
    open: () => void;
    write: (text: string) => void;
    close: () => void;
    isOpen: () => boolean;
  } => {
    let opened = false;
    let lineBuf = "";
    let acc = "";
    let bodyLineCount = 0;
    let maxOuter = 0;
    let inner = 0;

    const emitBodyRow = (row: string): void => {
      const padded = row.padEnd(inner);
      const interior = on
        ? `${s("│", "90")} ${s(padded, "97")} ${s("│", "90")}`
        : `│ ${padded} │`;
      process.stdout.write(interior + "\n");
      bodyLineCount++;
    };

    const emitWrappedLogicalLine = (logicalLine: string): void => {
      if (logicalLine === "") {
        emitBodyRow("");
        return;
      }
      const segments = wrapParagraphWords(logicalLine, inner);
      for (const seg of segments) emitBodyRow(seg);
    };

    return {
      open: (): void => {
        if (opened) return;
        opened = true;
        acc = "";
        bodyLineCount = 0;
        const cols = termCols();
        maxOuter = Math.max(miraBubbleMinOuter(), Math.floor(cols * 0.85));
        inner = Math.max(2, maxOuter - 4);
        if (!stdout.isTTY) process.stdout.write("\n");
        process.stdout.write(miraBubbleTopRule(maxOuter) + "\n");
      },
      write: (text: string): void => {
        acc += text;
        lineBuf += text;
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          emitWrappedLogicalLine(line);
        }
      },
      close: (): void => {
        if (!opened) return;
        if (lineBuf.length > 0) emitWrappedLogicalLine(lineBuf);
        lineBuf = "";

        const normAcc = acc.replace(/\r\n/g, "\n");
        const canReflow = stdout.isTTY && normAcc.trim().length > 0;

        if (canReflow) {
          const cols = termCols();
          const maxAllowed = Math.max(miraBubbleMinOuter(), Math.floor(cols * 0.85));
          let outer = maxAllowed;
          let wrapped: string[] = [];
          for (let i = 0; i < 8; i++) {
            const innerW = Math.max(2, outer - 4);
            wrapped = wrapMessageByNewlines(normAcc, innerW);
            const longest = wrapped.reduce((m, l) => Math.max(m, l.length), 1);
            const nextOuter = Math.max(miraBubbleMinOuter(), Math.min(maxAllowed, longest + 4));
            if (nextOuter === outer) break;
            outer = nextOuter;
          }
          const innerFinal = Math.max(2, outer - 4);
          const rowsToErase = 1 + bodyLineCount;
          process.stdout.write(`\x1b[${rowsToErase}A\r`);
          process.stdout.write("\x1b[0J");
          process.stdout.write(miraBubbleTopRule(outer) + "\n");
          for (const line of wrapped) {
            const padded = line.padEnd(innerFinal);
            const interior = on
              ? `${s("│", "90")} ${s(padded, "97")} ${s("│", "90")}`
              : `│ ${padded} │`;
            process.stdout.write(interior + "\n");
          }
          process.stdout.write(userBubbleBottomRule(outer) + "\n");
        } else {
          process.stdout.write(userBubbleBottomRule(maxOuter) + "\n");
        }

        opened = false;
        acc = "";
        bodyLineCount = 0;
      },
      isOpen: (): boolean => opened,
    };
  },
  miraReplyLinePrefix: (): string => {
    const lab = "mira".padEnd(LABEL_COL, " ");
    return on ? `\n${INDENT}${s(lab, "2")} ${s("✦", "35")} ` : `\n${INDENT}${lab} ✦ `;
  },

  /**
   * Print mira header and save cursor (DEC SC `\x1b7`) for inline spinner updates.
   * Pair with `replyInlineSpinnerStart` / `stop`.
   */
  miraReplyBegin: (): void => {
    process.stdout.write(ui.miraReplyLinePrefix());
    if (stdout.isTTY) process.stdout.write("\x1b7");
  },

  /**
   * Inline spinner on the mira line (after `miraReplyBegin`). Uses DEC SC/RC (`\\x1b7` / `\\x1b8`) so the
   * cursor can stay on streamed body lines while the spinner keeps updating on line 1.
   * Stop when the reply is done (`stop()` clears the spinner only).
   */
  replyInlineSpinnerStart: (): { stop: () => void } => {
    if (!stdout.isTTY) {
      return { stop: () => undefined };
    }
    const frames = on ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
    let i = 0;
    let stopped = false;
    let id: NodeJS.Timeout | undefined;
    const tick = () => {
      if (stopped) return;
      const f = frames[i++ % frames.length];
      process.stdout.write("\x1b8");
      process.stdout.write(on ? s(f, "2") : f);
      process.stdout.write(" \x1b[K");
    };
    tick();
    id = setInterval(tick, 90);
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (id !== undefined) clearInterval(id);
        process.stdout.write("\x1b8\x1b[K");
      },
    };
  },

  /** Status chips for slash commands and system messages. */
  ok: (text: string): void => {
    console.log(`  ${ui.green("ok")}  ${text}\n`);
  },
  tip: (text: string): void => {
    console.log(`  ${ui.cyan("·")}  ${ui.dim(text)}\n`);
  },
  warn: (text: string): void => {
    console.log(`  ${ui.yellow("!")}  ${text}\n`);
  },
  err: (text: string): void => {
    console.log(`  ${ui.red("✖")}  ${text}\n`);
  },

  goodbye: (): void => {
    console.log(ui.dim("\n  Later. Thanks for the bandwidth.\n"));
  },

  resumeCommand: (cmd: string): void => {
    ui.line();
    console.log(`  ${ui.bold("Archived")}${ui.dim(". To pick this thread back up:")}`);
    console.log(`  ${ui.gray(cmd)}`);
    console.log();
  },
};

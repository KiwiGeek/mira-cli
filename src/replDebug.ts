/** stderr traces for hangs around DOM waits / capture when `MIRA_DEBUG_REPL=1`. */

import fs from "node:fs";

export function replDebugEnabled(): boolean {
  return process.env.MIRA_DEBUG_REPL === "1";
}

function formatReplDebugArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === "object" && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(" ");
}

/**
 * Logs to stderr and optionally appends one line per call to `MIRA_DEBUG_REPL_FILE`
 * (survives noisy TTY redraws / spinner clutter).
 */
export function replDebug(...args: unknown[]): void {
  if (!replDebugEnabled()) return;
  const ts = new Date().toISOString();
  const body = formatReplDebugArgs(args);
  const line = `[mira/debug ${ts}] ${body}`;
  console.error(line);
  const fp = process.env.MIRA_DEBUG_REPL_FILE?.trim();
  if (!fp) return;
  try {
    fs.appendFileSync(fp, `${line}\n`);
  } catch {
    /* ignore disk errors */
  }
}

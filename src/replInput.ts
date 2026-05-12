import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ui } from "./replUi.js";

export type UserReadResult =
  | { kind: "line"; text: string }
  | { kind: "interrupt" };

let keypressEventsInstalled = false;

function ensureKeypressEvents(): void {
  if (!keypressEventsInstalled && input.isTTY) {
    readline.emitKeypressEvents(input);
    keypressEventsInstalled = true;
  }
}

/** Backslash + Enter continues on the next line (works when TTY raw mode is off). */
async function readLineWithBackslashContinuation(
  getPrompt: () => string,
  getContinuationPrompt: () => string,
  historySize: number,
): Promise<string> {
  const rl = readlinePromises.createInterface({
    input,
    output,
    historySize,
    terminal: true,
  });
  try {
    let acc = await rl.question(getPrompt());
    acc = acc.replace(/\r\n/g, "\n");
    while (acc.endsWith("\\")) {
      acc =
        acc.slice(0, -1).replace(/\r\n/g, "\n").trimEnd() +
        "\n" +
        (await rl.question(getContinuationPrompt())).replace(/\r\n/g, "\n");
    }
    return acc.trimEnd();
  } finally {
    output.write(ui.userInputEnd());
    rl.close();
  }
}

/**
 * Interactive multiline: Shift+Enter (or Meta+Enter) inserts a newline; Enter submits.
 * Ctrl+C ends the read and returns { kind: "interrupt" } so the REPL can run normal shutdown.
 */
async function readMultilineRaw(getPrompt: () => string): Promise<UserReadResult> {
  ensureKeypressEvents();

  return new Promise((resolve) => {
    const prompt = getPrompt();
    output.write(prompt);
    let buffer = "";

    if (input.isPaused()) input.resume();

    const wasRaw = input.isRaw;
    input.setRawMode(true);

    const cleanup = () => {
      input.setRawMode(wasRaw);
      input.removeListener("keypress", onKeypress);
    };

    const submit = () => {
      cleanup();
      output.write(ui.userInputEnd());
      if (input.isTTY) {
        const n = buffer.split("\n").length;
        if (n > 0) {
          output.write(`\x1b[${Math.max(0, n - 1)}A\r`);
          for (let i = 0; i < n; i++) {
            output.write("\x1b[2K");
            if (i < n - 1) output.write("\x1b[1B");
          }
          if (n > 1) output.write(`\x1b[${n - 1}A\r`);
        }
      } else {
        output.write("\n");
      }
      resolve({ kind: "line", text: buffer.trimEnd() });
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        output.write(`${ui.userInputEnd()}\n`);
        resolve({ kind: "interrupt" });
        return;
      }

      if (key && (key.name === "return" || key.name === "enter")) {
        if (key.shift || key.meta) {
          buffer += "\n";
          output.write("\n");
        } else {
          submit();
        }
        return;
      }

      if (key?.name === "backspace") {
        if (buffer.length > 0) {
          const ch = buffer[buffer.length - 1];
          buffer = buffer.slice(0, -1);
          if (ch === "\n") {
            output.write("\x1b[1A");
            const lastNl = buffer.lastIndexOf("\n");
            const seg = lastNl === -1 ? buffer : buffer.slice(lastNl + 1);
            output.write("\r\x1b[K");
            if (lastNl === -1) {
              output.write(prompt);
              output.write(seg);
            } else {
              output.write(seg);
            }
          } else {
            output.write("\b \b");
          }
        }
        return;
      }

      if (str && !key?.ctrl) {
        buffer += str;
        output.write(str);
      }
    };

    input.on("keypress", onKeypress);
  });
}

export function createMultilineReplInput(options: {
  getPrompt: () => string;
  getContinuationPrompt?: () => string;
  historySize: number;
}): { read(): Promise<UserReadResult> } {
  const cont = options.getContinuationPrompt ?? (() => "... ");
  return {
    async read(): Promise<UserReadResult> {
      if (!input.isTTY) {
        const text = await readLineWithBackslashContinuation(
          options.getPrompt,
          cont,
          options.historySize,
        );
        return { kind: "line", text };
      }
      return readMultilineRaw(options.getPrompt);
    },
  };
}

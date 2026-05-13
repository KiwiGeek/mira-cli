#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { defaultProfileDir, packageRoot } from "./paths.js";
import { launchChatGptContext } from "./launch.js";
import { chromiumInstallHint } from "./playwrightHint.js";
import { CHAT_URL, ChatGptSession, openPage } from "./session.js";
import { hideBrowserWindow, showBrowserWindow } from "./hideWindow.js";
import { diagnoseBrowserWindows, isWin32, windowDebugEnabled } from "./win32Window.js";
import {
  composePrimingInstructions,
  CLI_USER_MESSAGE_SEPARATOR,
  defaultInstructionsPath,
  formatTerminalSessionBlock,
  formatUserInstructionsRefreshBlock,
  readUserInstructionsSnap,
  snapshotTerminalSize,
  ensureUserInstructionsFile,
} from "./cliInstructions.js";
import {
  conversationIdFromChatUrl,
  formatShortConversationId,
  listConversationsSorted,
  resolveConversationPrefix,
  upsertArchivedConversation,
} from "./chatHistory.js";
import { readActiveConversationTitle } from "./selectors.js";
import { ui } from "./replUi.js";
import {
  formatAssistantBullets,
  streamFormatCompleteLines,
  streamFormatFlushTail,
  type AssistantStreamLineState,
} from "./assistantFormat.js";
import { createMultilineReplInput } from "./replInput.js";
import { maybePromptGitUpdate } from "./gitUpdate.js";
import { formatInstalledVersionLines, formatWhoamiLines } from "./versionInfo.js";
import { openPathWithSystemDefault } from "./osOpen.js";

const DEFAULT_HISTORY_LIST_LIMIT = 10;
const HISTORY_LIST_CAP = 500;

function reportPlaywrightLaunchFailure(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const looksPlaywright =
    msg.includes("Executable doesn't exist") || msg.includes("browserType.launchPersistentContext");
  if (looksPlaywright) {
    console.error(chromiumInstallHint(packageRoot()));
  } else {
    console.error(msg);
  }
  process.exit(1);
}

/** Clear visible viewport (ANSI); non-TTY prints blank lines instead of escape codes. */
function clearReplViewport(): void {
  if (output.isTTY) {
    output.write("\x1b[2J\x1b[H");
  } else {
    const rows = typeof output.rows === "number" && output.rows > 0 ? output.rows : 24;
    console.log("\n".repeat(Math.min(rows + 8, 64)));
  }
}

function parseChatUrlQuiet(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return undefined;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "chatgpt.com" && host !== "chat.openai.com") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function validateChatUrl(raw: string): string | undefined {
  const ok = parseChatUrlQuiet(raw);
  if (ok) return ok;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") {
      console.warn("[mira] --chat-url must use https://");
      return undefined;
    }
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "chatgpt.com" && host !== "chat.openai.com") {
      console.warn("[mira] --chat-url host must be chatgpt.com or chat.openai.com");
      return undefined;
    }
    return u.toString();
  } catch {
    console.warn("[mira] Invalid --chat-url (not a valid URL)");
    return undefined;
  }
}

function helpRow(cmd: string, desc: string): void {
  console.log(`    ${ui.cyan(cmd.padEnd(16))} ${ui.dim(desc)}`);
}

function printHelp(): void {
  console.log();
  ui.line();
  console.log(`  ${ui.bold("Mira")}  ${ui.gray("·")}  ${ui.dim("ChatGPT in the terminal (browser session; no API key)")}`);
  ui.line();

  console.log(`  ${ui.bold(ui.cyan("Usage"))}`);
  console.log(`    ${ui.gray("chatgpt-repl login")} ${ui.dim("[--profile DIR]")}`);
  console.log(`      ${ui.dim("Open Chromium, sign in, press Enter when ready.")}`);
  console.log(`    ${ui.gray("chatgpt-repl list")} ${ui.dim("[--limit N] [--all]")}`);
  console.log(
    `      ${ui.dim(`Print saved archive threads (default ${DEFAULT_HISTORY_LIST_LIMIT}); `)}` +
      `${ui.gray("--all")}${ui.dim(` shows up to ${String(HISTORY_LIST_CAP)}.`)}`,
  );
  console.log(`    ${ui.gray("chatgpt-repl resume")} ${ui.dim("<id-prefix> [options…]")}`);
  console.log(`      ${ui.dim("Resume a saved thread by short id (Docker-style prefix match).")}`);
  console.log(`    ${ui.gray("chatgpt-repl")} ${ui.dim("[options…]")}`);
  console.log(
    `      ${ui.dim("Interactive REPL: ")}${ui.cyan("Shift+Enter")}${ui.dim(" newline; Enter sends. Pipes: line ends with ")}${ui.gray("\\")}${ui.dim(" + Enter.")}`,
  );
  console.log();

  console.log(`  ${ui.bold(ui.cyan("First time"))}`);
  console.log(`    ${ui.gray("npm install")} ${ui.dim("·")} ${ui.gray("npx playwright install chromium")}`);
  console.log();

  console.log(`  ${ui.bold(ui.cyan("Custom instructions"))}`);
  console.log(`    ${ui.dim("Built-in preamble first; optional file appends after it. Open/edit with")} ${ui.gray("/instructions")}`);
  console.log(`    ${ui.gray(defaultInstructionsPath())}`);
  console.log();

  console.log(`  ${ui.bold(ui.cyan("REPL commands"))}`);
  helpRow("/new", `New chat (opens ${CHAT_URL})`);
  helpRow("/name …", "Rename thread (alias /rename)");
  helpRow("/show", "Show browser, move window on-screen (Win32 + CDP)");
  helpRow("/debug-window", "Dump HWNDs (Windows · stderr)");
  helpRow("/clear", "Clear the terminal viewport");
  helpRow("/help", "This help");
  helpRow("/version", "Show npm package version and git commit (when installed from a clone)");
  helpRow("/whoami", "Show package path, git root, browser profile, state dir");
  helpRow("/instructions", "Open custom instructions file (~/.mira/instructions.txt)");
  helpRow("/quit", "Exit — archives by default; saves thread to history + resume hints");
  console.log();

  console.log(`  ${ui.bold(ui.cyan("Flags"))}`);
  helpRow("(default)", "Headed browser, hidden off taskbar after load (Win32 / CDP)");
  helpRow("--show-window", "Keep browser visible (--no-hide)");
  helpRow("--hide-window", "Explicit default hidden mode");
  helpRow("--headless", "Headless Chromium (ignored if hidden-window mode is on)");
  helpRow("--profile DIR", "Persistent browser profile directory");
  helpRow("--debug-window / --debug-archive", "Verbose stderr; or set CHATGPT_REPL_DEBUG_*");
  helpRow("--no-stream", "Print each reply as one block");
  helpRow("--on-exit", "none | archive (default) | delete");
  helpRow("--chat-url", "Resume thread URL; skips merged first-message instructions");
  helpRow("--no-prime", "Do not merge CLI instructions into the first message");
  helpRow("--limit / -n", `History list rows (default ${DEFAULT_HISTORY_LIST_LIMIT}; --all caps at ${HISTORY_LIST_CAP})`);
  console.log(`  ${ui.dim("Env:")} ${ui.gray("MIRA_SKIP_UPDATE_CHECK=1")}${ui.dim(" skip git upstream prompt on launch.")}`);
  console.log();

  console.log(`  ${ui.dim("Streaming reads the page DOM; if sending breaks, adjust selectors. Set NO_COLOR=1 to strip ANSI.")}`);
  ui.line();
  console.log();
}

type ParsedCli =
  | {
      cmd: "repl";
      profileDir: string;
      headless: boolean;
      hideWindow: boolean;
      noPrime: boolean;
      noStream: boolean;
      onExit: "none" | "archive" | "delete";
      chatUrl?: string;
      verbose: boolean;
    }
  | { cmd: "login"; profileDir: string; verbose: boolean }
  | { cmd: "list"; profileDir: string; historyLimit: number; verbose: boolean }
  | {
      cmd: "resume";
      resumePartial: string;
      profileDir: string;
      headless: boolean;
      hideWindow: boolean;
      noPrime: boolean;
      noStream: boolean;
      onExit: "none" | "archive" | "delete";
      verbose: boolean;
    };

function formatRecordedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  } catch {
    return iso;
  }
}

function truncatePlain(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function printArchivedConversationList(limit: number): void {
  const all = listConversationsSorted();
  const rows = all.slice(0, limit);
  ui.line();
  console.log(
    `  ${ui.bold("Archived conversations")}${ui.dim(
      ` · showing ${rows.length}${all.length > rows.length ? ` of ${all.length}` : ""}`,
    )}`,
  );
  ui.line();
  if (rows.length === 0) {
    console.log(`  ${ui.dim("No saved threads yet. Quit with default archive to record one.")}`);
    console.log();
    ui.line();
    console.log();
    return;
  }

  const idW = 14;
  const dateW = 26;
  console.log(`  ${ui.gray("ID".padEnd(idW))}${ui.gray("ARCHIVED AT".padEnd(dateW))}${ui.gray("TITLE")}`);
  for (const r of rows) {
    const sid = formatShortConversationId(r.conversationId);
    const date = formatRecordedAt(r.recordedAt);
    const titleOut = r.title ? truncatePlain(r.title, 96) : ui.dim("(untitled)");
    console.log(`  ${sid.padEnd(idW)} ${date.padEnd(dateW)} ${titleOut}`);
  }
  console.log(`  ${ui.dim(`Resume: npm run mira -- resume <id-prefix>`)}`);
  console.log();
  ui.line();
  console.log();
}

function parseArgs(argv: string[]): ParsedCli {
  const tokens = [...argv];

  let cmd: ParsedCli["cmd"] = "repl";
  let resumePartial: string | undefined;

  if (tokens[0] === "login") {
    cmd = "login";
    tokens.shift();
  } else if (tokens[0] === "list") {
    cmd = "list";
    tokens.shift();
  } else if (tokens[0] === "resume") {
    cmd = "resume";
    tokens.shift();
    if (tokens[0] && !tokens[0].startsWith("-")) {
      resumePartial = tokens.shift();
    }
  }

  let profileDir = defaultProfileDir();
  let headless = false;
  let hideWindow = true;
  let noPrime = false;
  let noStream = false;
  let onExit: "none" | "archive" | "delete" = "archive";
  let chatUrl: string | undefined;
  let verbose = process.env.CHATGPT_REPL_VERBOSE === "1";

  let historyLimit = DEFAULT_HISTORY_LIST_LIMIT;
  let historyShowAll = false;

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === "--headless") headless = true;
    else if (a === "--show-window" || a === "--no-hide") hideWindow = false;
    else if (a === "--hide-window") hideWindow = true;
    else if (a === "--no-prime") noPrime = true;
    else if (a === "--no-stream") noStream = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--debug-window") process.env.CHATGPT_REPL_DEBUG_WINDOW = "1";
    else if (a === "--debug-archive") process.env.CHATGPT_REPL_DEBUG_ARCHIVE = "1";
    else if (a === "--all") historyShowAll = true;
    else if ((a === "-n" || a === "--limit") && tokens[i + 1]) {
      const raw = tokens[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        console.warn(`[mira] Ignoring invalid --limit "${raw}"`);
      } else {
        historyLimit = Math.min(Math.floor(n), HISTORY_LIST_CAP);
      }
    } else if (a === "--on-exit" && tokens[i + 1]) {
      const v = tokens[++i].toLowerCase();
      if (v === "none" || v === "archive" || v === "delete") onExit = v;
      else {
        console.warn(`[mira] Unknown --on-exit "${v}" (use none, archive, delete); using archive.`);
        onExit = "archive";
      }
    } else if (a === "--chat-url" && tokens[i + 1]) {
      const v = validateChatUrl(tokens[++i]);
      if (v) chatUrl = v;
    } else if (a === "--profile" && tokens[i + 1]) {
      profileDir = path.resolve(tokens[++i]);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.warn(`[mira] Unknown argument: ${a}`);
    }
  }

  const wantsBrowser = cmd === "repl" || cmd === "resume" || cmd === "login";
  if (wantsBrowser && hideWindow && headless) {
    console.warn("Note: hidden window mode needs a headed browser; --headless is ignored.");
    headless = false;
  }

  const effectiveHistoryLimit = historyShowAll ? HISTORY_LIST_CAP : Math.min(historyLimit, HISTORY_LIST_CAP);

  if (cmd === "list") {
    return { cmd: "list", profileDir, verbose, historyLimit: effectiveHistoryLimit };
  }

  if (cmd === "resume") {
    if (!resumePartial?.trim()) {
      console.error("[mira] Usage: chatgpt-repl resume <id-prefix> [options…]");
      process.exit(2);
    }
    return {
      cmd: "resume",
      resumePartial: resumePartial.trim(),
      profileDir,
      headless,
      hideWindow,
      noPrime,
      noStream,
      onExit,
      verbose,
    };
  }

  if (cmd === "login") {
    return { cmd: "login", profileDir, verbose };
  }

  return {
    cmd: "repl",
    profileDir,
    headless,
    hideWindow,
    noPrime,
    noStream,
    onExit,
    chatUrl,
    verbose,
  };
}

async function ensureProfileDir(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
}

async function runLogin(profileDir: string): Promise<void> {
  await ensureProfileDir(profileDir);
  await maybePromptGitUpdate();
  ui.line();
  console.log(`  ${ui.bold("Login")}  ${ui.dim("— opening Chromium with profile:")}`);
  console.log(`  ${ui.gray(profileDir)}`);
  console.log(`  ${ui.dim("Sign in at")} ${CHAT_URL}`);
  ui.line();
  console.log();
  let context;
  try {
    context = await launchChatGptContext(profileDir, false);
  } catch (e) {
    reportPlaywrightLaunchFailure(e);
  }
  try {
    const page = await openPage(context);
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });
    const rl = readline.createInterface({ input, output });
    await rl.question(
      ui.dim("When the chat UI looks good, press Enter here to save and close… "),
    );
    rl.close();
  } finally {
    await context.close();
  }
  console.log(ui.dim("Session saved.") + " Run " + ui.gray("mira") + " anytime.");
}

function releaseReplTerminal(): void {
  try {
    if (input.isTTY && input.isRaw) {
      input.setRawMode(false);
    }
  } catch {
    /* ignore */
  }
  input.removeAllListeners("keypress");
  try {
    input.pause();
  } catch {
    /* ignore */
  }
}

async function runRepl(
  profileDir: string,
  headless: boolean,
  hideWindow: boolean,
  noPrime: boolean,
  noStream: boolean,
  onExit: "none" | "archive" | "delete",
  chatUrl: string | undefined,
  verbose: boolean,
): Promise<void> {
  await ensureProfileDir(profileDir);
  await maybePromptGitUpdate();
  let context;
  try {
    context = await launchChatGptContext(profileDir, headless, {
      spawnOffScreen: hideWindow,
    });
  } catch (e) {
    reportPlaywrightLaunchFailure(e);
  }

  const page = await openPage(context);
  const session = new ChatGptSession(page, headless);

  let hideTipShown = false;
  async function tryConcealBrowser(opts?: { warnOnFailure?: boolean }): Promise<void> {
    if (!hideWindow) return;
    try {
      const hid = await hideBrowserWindow(page, profileDir);
      if (!hideTipShown && (hid.usedWin32 || hid.usedCdpOffScreen)) {
        hideTipShown = true;
        if (verbose) {
          if (hid.usedWin32) {
            ui.tip("Browser tucked away (Windows: off taskbar / Alt+Tab). /show brings it back.");
          } else if (hid.usedCdpOffScreen) {
            ui.tip("Browser nudged off-screen (CDP). May still show a taskbar icon; Win32 hide missed or non-Windows.");
          }
        }
      }
    } catch (err) {
      if (opts?.warnOnFailure) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.warn(`Could not hide the browser window: ${msg}`);
      }
    }
  }

  await tryConcealBrowser();

  await session.openChat(chatUrl, {
    afterNavigate: hideWindow ? () => tryConcealBrowser({ warnOnFailure: true }) : undefined,
  });

  if (windowDebugEnabled() && !hideWindow) {
    console.error(
        "[mira] --debug-window logs Win32 hide diagnostics; hiding is off because of --show-window or --no-hide.\n" +
        "[mira] Run without --show-window (default) to hide the browser, e.g. npm run mira -- --debug-window\n",
    );
  }

  let pendingPrime = !noPrime && !chatUrl ? composePrimingInstructions().trim() : "";

  let lastUserInstructionsFingerprint: string | undefined;

  if (pendingPrime && verbose) {
    console.log(`  ${ui.dim("CLI instructions will be sent with your first message (one assistant reply).")}`);
    console.log();
  }

  ui.banner({ resumedChat: Boolean(chatUrl) });

  const replIn = createMultilineReplInput({
    getPrompt: () => ui.promptYou(),
    historySize: 100,
  });

  /** Last terminal size embedded in an outbound message (null until first send). */
  let lastTerminalSent: { cols: number; rows: number } | null = null;

  async function sendChatMessage(toSend: string): Promise<void> {
    ui.printUserMessageBubble(toSend);

    const { cols, rows } = snapshotTerminalSize();
    const geomStale =
      lastTerminalSent === null ||
      lastTerminalSent.cols !== cols ||
      lastTerminalSent.rows !== rows;
    let sessionGeo = "";
    if (geomStale) {
      sessionGeo = `${formatTerminalSessionBlock(cols, rows)}\n\n`;
      lastTerminalSent = { cols, rows };
    }

    const primeSnapshot = pendingPrime;
    let userInstrAttach = "";
    const snapNow = readUserInstructionsSnap();
    if (!noPrime && !primeSnapshot && snapNow.fingerprint !== lastUserInstructionsFingerprint) {
      userInstrAttach = `${formatUserInstructionsRefreshBlock(snapNow)}\n\n`;
    }

    let payload = toSend;
    if (primeSnapshot) {
      pendingPrime = "";
      payload = `${primeSnapshot}\n\n${sessionGeo}${userInstrAttach}${CLI_USER_MESSAGE_SEPARATOR}${toSend}`;
    } else if (sessionGeo || userInstrAttach) {
      payload = `${sessionGeo}${userInstrAttach}${CLI_USER_MESSAGE_SEPARATOR}${toSend}`;
    }

    ui.miraReplyBegin();
    const spin = ui.replyInlineSpinnerStart();
    let stopped = false;
    const stopSpin = () => {
      if (!stopped) {
        spin.stop();
        stopped = true;
      }
    };

    const box = ui.createReplyBoxWriter();

    const openBox = (): void => {
      if (box.isOpen()) return;
      stopSpin();
      ui.prepForReplyBoxOpen();
      box.open();
    };

    let sendCompletedOk = false;
    try {
      if (noStream) {
        const reply = await session.send(payload);
        const norm = reply.replace(/\r\n/g, "\n");
        if (norm.trim()) {
          openBox();
          box.write(formatAssistantBullets(norm));
        }
      } else {
        const streamState: AssistantStreamLineState = { committed: 0 };
        let bodyStarted = false;
        const reply = await session.send(payload, {
          onAssistantDelta: (full: string) => {
            const norm = full.replace(/\r\n/g, "\n");
            const { chunk } = streamFormatCompleteLines(streamState, norm);
            if (!chunk) return;
            if (!bodyStarted) {
              bodyStarted = true;
              openBox();
            }
            box.write(chunk);
          },
        });
        const norm = reply.replace(/\r\n/g, "\n");
        let rest = streamFormatCompleteLines(streamState, norm).chunk;
        rest += streamFormatFlushTail(streamState, norm);
        if (rest) {
          if (!bodyStarted) {
            bodyStarted = true;
            openBox();
          }
          box.write(rest);
        }
        if (!bodyStarted && norm.trim()) {
          openBox();
          box.write(formatAssistantBullets(norm));
        }
      }
      sendCompletedOk = true;
    } catch (err) {
      process.stdout.write("\n");
      const msg = err instanceof Error ? err.message : String(err);
      ui.err(msg);
    } finally {
      stopSpin();
      if (box.isOpen()) box.close();
      process.stdout.write("\n");
      if (sendCompletedOk && !noPrime) {
        lastUserInstructionsFingerprint = readUserInstructionsSnap().fingerprint;
      }
    }
  }

  try {
    for (;;) {
      const inRes = await replIn.read();
      if (inRes.kind === "interrupt") {
        console.log(`  ${ui.dim("Shutting down…")}\n`);
        break;
      }

      const raw = inRes.text.replace(/\r\n/g, "\n");
      if (!raw.trim()) continue;

      const singleLine = !raw.includes("\n");
      const one = raw.trim();

      if (singleLine && (one === "/quit" || one === "/exit")) {
        console.log(`  ${ui.dim("Shutting down…")}\n`);
        break;
      }
      if (singleLine && one === "/help") {
        printHelp();
        continue;
      }
      if (singleLine && one === "/version") {
        const lines = formatInstalledVersionLines();
        if (lines.length > 0) {
          console.log(`  ${ui.green("ok")}  ${lines[0]}`);
          for (let i = 1; i < lines.length; i++) {
            console.log(`      ${ui.dim(lines[i]!)}`);
          }
          console.log();
        }
        continue;
      }
      if (singleLine && one === "/whoami") {
        const lines = formatWhoamiLines(profileDir);
        console.log(`  ${ui.green("ok")}  ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
          console.log(`      ${ui.dim(lines[i]!)}`);
        }
        console.log();
        continue;
      }
      if (singleLine && one === "/instructions") {
        try {
          const p = ensureUserInstructionsFile();
          if (openPathWithSystemDefault(p)) {
            ui.ok("Opened instructions file in your default app.");
            console.log(`      ${ui.dim(p)}`);
            console.log(`      ${ui.dim("Save when done — your next message carries changes (built-in preamble stays first).")}`);
            console.log();
          } else {
            ui.warn(`Could not launch an editor for:\n      ${p}\n      Open that path manually.`);
          }
        } catch (e) {
          ui.err(e instanceof Error ? e.message : String(e));
        }
        continue;
      }
      if (singleLine && (one.startsWith("/name ") || one.startsWith("/rename "))) {
        const title = one.replace(/^\/(name|rename)\s+/, "").trim();
        if (!title) {
          ui.tip("Usage: /name <new title>");
          continue;
        }
        const ok = await session.renameChat(title);
        if (ok) ui.ok("Chat renamed.");
        else ui.warn("Rename didn’t land — tweak selectors or finish in the browser.");
        continue;
      }
      if (singleLine && (one === "/name" || one === "/rename")) {
        ui.tip("Usage: /name <new title>");
        continue;
      }
      if (singleLine && one === "/new") {
        try {
          await session.newConversation();
          pendingPrime = !noPrime ? composePrimingInstructions().trim() : "";
          lastTerminalSent = null;
          lastUserInstructionsFingerprint = undefined;
          ui.ok("New conversation. Blank slate, same swagger.");
        } catch (e) {
          ui.err(e instanceof Error ? e.message : String(e));
        }
        continue;
      }
      if (singleLine && one === "/show") {
        const ok = await showBrowserWindow(page, profileDir);
        if (ok) ui.ok("Window restored.");
        else ui.warn("Win32 restore missed — try taskbar or Alt+Tab if it was only off-screen.");
        continue;
      }
      if (singleLine && one === "/debug-window") {
        if (!isWin32()) {
          ui.tip("/debug-window is Windows-only.");
        } else {
          ui.tip("HWND dump on stderr.");
          diagnoseBrowserWindows(page, profileDir);
        }
        continue;
      }

      const toSend = raw.trimEnd();
      await sendChatMessage(toSend);
    }
  } finally {
    releaseReplTerminal();
    try {
      if (onExit !== "none") {
        let snapshotTitle: string | null = null;
        let snapshotConvId: string | null = null;
        if (onExit === "archive") {
          snapshotConvId = conversationIdFromChatUrl(page.url());
          if (snapshotConvId) {
            try {
              snapshotTitle = await readActiveConversationTitle(page);
            } catch {
              snapshotTitle = null;
            }
          }
        }

        const r = await session.finalizeConversation(onExit);
        if (r.acted && !r.ok) {
          ui.warn(
            "Exit cleanup didn’t finish (ChatGPT UI may have shifted). Check the browser. " +
              "For traces: --debug-archive or CHATGPT_REPL_DEBUG_ARCHIVE=1.",
          );
        } else if (r.acted && onExit === "archive" && r.conversationUrl) {
          const cid = conversationIdFromChatUrl(r.conversationUrl);
          const titleForHistory =
            snapshotConvId && cid && snapshotConvId === cid ? snapshotTitle : null;
          const resumeById =
            cid !== null ? `npm run mira -- resume ${formatShortConversationId(cid)}` : undefined;
          ui.resumeCommand(`npm run mira -- --chat-url "${r.conversationUrl}"`, {
            resumeCli: resumeById,
          });
          if (r.ok) {
            upsertArchivedConversation({ url: r.conversationUrl, title: titleForHistory });
          }
        } else if (r.acted && onExit === "delete") {
          ui.ok("Conversation deleted.");
        }
      }
    } catch (e) {
      console.warn("[mira] exit cleanup error:", e instanceof Error ? e.message : String(e));
    }
    ui.goodbye();
    await context.close();
    process.exit(0);
  }
}

const args = process.argv.slice(2);
if (args.includes("--debug-window")) process.env.CHATGPT_REPL_DEBUG_WINDOW = "1";
if (args.includes("--debug-archive")) process.env.CHATGPT_REPL_DEBUG_ARCHIVE = "1";
const parsed = parseArgs(args);

if (parsed.cmd === "login") {
  await runLogin(parsed.profileDir);
} else if (parsed.cmd === "list") {
  printArchivedConversationList(parsed.historyLimit);
} else if (parsed.cmd === "resume") {
  const hit = resolveConversationPrefix(parsed.resumePartial);
  if (hit.kind === "none") {
    console.error("[mira] No saved conversation matches that id prefix.");
    process.exit(2);
  }
  if (hit.kind === "ambiguous") {
    console.error("[mira] Ambiguous id — prefix matches multiple threads:");
    for (const m of hit.matches) {
      const title = m.title ? truncatePlain(m.title, 120) : "(untitled)";
      console.error(`    ${formatShortConversationId(m.conversationId)}  ${formatRecordedAt(m.recordedAt)}  ${title}`);
    }
    process.exit(2);
  }
  const url = parseChatUrlQuiet(hit.record.url);
  if (!url) {
    console.error("[mira] Stored URL is invalid. Edit or delete ~/.mira/conversations.json");
    process.exit(2);
  }
  await runRepl(
    parsed.profileDir,
    parsed.headless,
    parsed.hideWindow,
    parsed.noPrime,
    parsed.noStream,
    parsed.onExit,
    url,
    parsed.verbose,
  );
} else {
  await runRepl(
    parsed.profileDir,
    parsed.headless,
    parsed.hideWindow,
    parsed.noPrime,
    parsed.noStream,
    parsed.onExit,
    parsed.chatUrl,
    parsed.verbose,
  );
}

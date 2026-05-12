#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { defaultProfileDir } from "./paths.js";
import { launchChatGptContext } from "./launch.js";
import { CHAT_URL, ChatGptSession, openPage } from "./session.js";
import { hideBrowserWindow, showBrowserWindow } from "./hideWindow.js";
import { diagnoseBrowserWindows, isWin32, windowDebugEnabled } from "./win32Window.js";
import { defaultInstructionsPath, loadCliInstructions, CLI_USER_MESSAGE_SEPARATOR } from "./cliInstructions.js";
import { ui } from "./replUi.js";
import {
  formatAssistantBullets,
  streamFormatCompleteLines,
  streamFormatFlushTail,
  type AssistantStreamLineState,
} from "./assistantFormat.js";
import { createMultilineReplInput } from "./replInput.js";

function validateChatUrl(raw: string): string | undefined {
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
  console.log(`    ${ui.gray("chatgpt-repl")} ${ui.dim("[options…]")}`);
  console.log(
    `      ${ui.dim("Interactive REPL: ")}${ui.cyan("Shift+Enter")}${ui.dim(" newline; Enter sends. Pipes: line ends with ")}${ui.gray("\\")}${ui.dim(" + Enter.")}`,
  );
  console.log();

  console.log(`  ${ui.bold(ui.cyan("First time"))}`);
  console.log(`    ${ui.gray("npm install")} ${ui.dim("·")} ${ui.gray("npx playwright install chromium")}`);
  console.log();

  console.log(`  ${ui.bold(ui.cyan("Custom instructions"))}`);
  console.log(`    ${ui.dim("Optional file replaces the built-in preamble:")}`);
  console.log(`    ${ui.gray(defaultInstructionsPath())}`);
  console.log();

  console.log(`  ${ui.bold(ui.cyan("REPL commands"))}`);
  helpRow("/new", `New chat (opens ${CHAT_URL})`);
  helpRow("/name …", "Rename thread (alias /rename)");
  helpRow("/show", "Show browser, move window on-screen (Win32 + CDP)");
  helpRow("/debug-window", "Dump HWNDs (Windows · stderr)");
  helpRow("/help", "This help");
  helpRow("/quit", "Exit — archives by default, prints --chat-url resume");
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
  helpRow("--verbose", "Print startup tips (browser hide, first-message primer); or CHATGPT_REPL_VERBOSE=1");
  console.log();

  console.log(`  ${ui.dim("Streaming reads the page DOM; if sending breaks, adjust selectors. Set NO_COLOR=1 to strip ANSI.")}`);
  ui.line();
  console.log();
}

function parseArgs(argv: string[]): {
  cmd: "repl" | "login";
  profileDir: string;
  headless: boolean;
  hideWindow: boolean;
  noPrime: boolean;
  noStream: boolean;
  onExit: "none" | "archive" | "delete";
  chatUrl?: string;
  verbose: boolean;
} {
  let profileDir = defaultProfileDir();
  let headless = false;
  let hideWindow = true;
  let noPrime = false;
  let noStream = false;
  let onExit: "none" | "archive" | "delete" = "archive";
  let chatUrl: string | undefined;
  let cmd: "repl" | "login" = "repl";
  let verbose = process.env.CHATGPT_REPL_VERBOSE === "1";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "login") cmd = "login";
    else if (a === "--headless") headless = true;
    else if (a === "--show-window" || a === "--no-hide") hideWindow = false;
    else if (a === "--hide-window") hideWindow = true;
    else if (a === "--no-prime") noPrime = true;
    else if (a === "--no-stream") noStream = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--debug-window") process.env.CHATGPT_REPL_DEBUG_WINDOW = "1";
    else if (a === "--debug-archive") process.env.CHATGPT_REPL_DEBUG_ARCHIVE = "1";
    else if (a === "--on-exit" && argv[i + 1]) {
      const v = argv[++i].toLowerCase();
      if (v === "none" || v === "archive" || v === "delete") onExit = v;
      else {
        console.warn(`[mira] Unknown --on-exit "${v}" (use none, archive, delete); using archive.`);
        onExit = "archive";
      }
    } else if (a === "--chat-url" && argv[i + 1]) {
      const v = validateChatUrl(argv[++i]);
      if (v) chatUrl = v;
    } else if (a === "--profile" && argv[i + 1]) {
      profileDir = path.resolve(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (hideWindow && headless) {
    console.warn("Note: hidden window mode needs a headed browser; --headless is ignored.");
    headless = false;
  }
  return { cmd, profileDir, headless, hideWindow, noPrime, noStream, onExit, chatUrl, verbose };
}

async function ensureProfileDir(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
}

async function runLogin(profileDir: string): Promise<void> {
  await ensureProfileDir(profileDir);
  ui.line();
  console.log(`  ${ui.bold("Login")}  ${ui.dim("— opening Chromium with profile:")}`);
  console.log(`  ${ui.gray(profileDir)}`);
  console.log(`  ${ui.dim("Sign in at")} ${CHAT_URL}`);
  ui.line();
  console.log();
  const context = await launchChatGptContext(profileDir, false);
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
  console.log(ui.dim("Session saved.") + " Run " + ui.gray("npm run mira") + " anytime.");
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
  let context;
  try {
    context = await launchChatGptContext(profileDir, headless, {
      spawnOffScreen: hideWindow,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launchPersistentContext")) {
      console.error("Chromium is not installed for Playwright. Run: npx playwright install chromium");
    } else {
      console.error(msg);
    }
    process.exit(1);
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

  let pendingPrime = !noPrime && !chatUrl ? loadCliInstructions().trim() : "";

  if (pendingPrime && verbose) {
    console.log(`  ${ui.dim("CLI instructions will be sent with your first message (one assistant reply).")}`);
    console.log();
  }

  ui.banner({ resumedChat: Boolean(chatUrl) });

  const replIn = createMultilineReplInput({
    getPrompt: () => ui.promptYou(),
    historySize: 100,
  });

  async function sendChatMessage(toSend: string): Promise<void> {
    ui.printUserMessageBubble(toSend);

    let payload = toSend;
    if (pendingPrime) {
      payload = `${pendingPrime}${CLI_USER_MESSAGE_SEPARATOR}${toSend}`;
      pendingPrime = "";
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
    } catch (err) {
      process.stdout.write("\n");
      const msg = err instanceof Error ? err.message : String(err);
      ui.err(msg);
    } finally {
      stopSpin();
      if (box.isOpen()) box.close();
      process.stdout.write("\n");
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
          pendingPrime = !noPrime ? loadCliInstructions().trim() : "";
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
        const r = await session.finalizeConversation(onExit);
        if (!r.acted) {
          ui.warn("No /c/… thread in the address bar — exit cleanup skipped.");
        } else if (!r.ok) {
          ui.warn(
            "Exit cleanup didn’t finish (ChatGPT UI may have shifted). Check the browser. " +
              "For traces: --debug-archive or CHATGPT_REPL_DEBUG_ARCHIVE=1.",
          );
        } else if (onExit === "archive" && r.conversationUrl) {
          ui.resumeCommand(`npm run mira -- --chat-url "${r.conversationUrl}"`);
        } else if (onExit === "delete") {
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

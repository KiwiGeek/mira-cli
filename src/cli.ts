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
import { defaultInstructionsPath, loadCliInstructions } from "./cliInstructions.js";

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

function printHelp(): void {
  console.log(`Mira — CLI for ChatGPT (web / Pro session). Chromium profile, no OpenAI API key.

Usage:
  chatgpt-repl login [--profile DIR]     Open Chromium; sign in; press Enter when ready.
  chatgpt-repl [--profile DIR] [--headless] [--show-window | --no-hide] [--no-prime] [--no-stream]
                 [--debug-window] [--debug-archive] [--on-exit none|archive|delete] [--chat-url URL]

First-time setup:
  npm install
  npx playwright install chromium

Custom instructions (optional): create or edit
  ${defaultInstructionsPath()}
  to replace the built-in preamble (e.g. how Mira should sound).

REPL commands:
  /new           Start a new chat (best effort; may use ${CHAT_URL})
  /name …        Rename the current chat (web UI ⋯ → Rename). Alias: /rename
  /show          Restore the browser window after hidden mode (Win32 hide / show)
  /debug-window  List top-level HWNDs for the browser PID tree (Windows, stderr)
  /help          This text
  /quit          Exit (default: archive thread and print --chat-url resume command)

Flags:
  (default)        Headed browser is hidden after load: moved off taskbar / Alt+Tab on Windows, then
                   SW_HIDE (or CDP off-screen fallback). No minimize.
  --show-window    Do not hide: keep the browser fully visible and on the taskbar like a normal window.
  --no-hide        Same as --show-window.
  --hide-window    Same as default (explicit); kept for scripts that already pass it.
  --debug-window   Log Win32 hide steps to stderr when hiding runs (default mode). Little effect with
                   --show-window / --no-hide, since nothing is hidden.
  --debug-archive  Log --on-exit archive/delete steps to stderr (menus, clicks, DOM snapshot). Or set
                   CHATGPT_REPL_DEBUG_ARCHIVE=1.
  --no-stream      Buffer each reply: print the full answer once (no token-at-a-time from DOM polling).
  --on-exit MODE   On /quit: archive (default), delete, or none. archive prints a --chat-url command to
                   resume. delete removes the chat. none skips cleanup.
  --chat-url URL   Start on this chat thread (https://chatgpt.com/c/…). Skips the initial priming
                   message (session already has context). Use the command printed when exiting after archive.

Notes:
  Replies stream by polling the last assistant bubble in the page (no CDP/WebSocket to the model);
  use --no-stream if you prefer one block of text. Priming stays buffered.
  ChatGPT’s DOM changes often; if sending breaks, update src/selectors.ts.
  --on-exit runs when the REPL exits via /quit (and similar normal teardown). Default is archive; use
  --on-exit delete or none to change. Ctrl+C may terminate the process before cleanup runs.
  Headless may be blocked; try CHATGPT_REPL_CHANNEL=chrome if you have Google Chrome installed.
  [mira/…] lines are stderr (same console as normal output). Capture: PowerShell
  npm run mira -- --debug-window 2>&1 | Tee-Object mira.log
  npm run mira -- --debug-archive 2>&1 | Tee-Object mira-archive.log
`);
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
} {
  let profileDir = defaultProfileDir();
  let headless = false;
  let hideWindow = true;
  let noPrime = false;
  let noStream = false;
  let onExit: "none" | "archive" | "delete" = "archive";
  let chatUrl: string | undefined;
  let cmd: "repl" | "login" = "repl";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "login") cmd = "login";
    else if (a === "--headless") headless = true;
    else if (a === "--show-window" || a === "--no-hide") hideWindow = false;
    else if (a === "--hide-window") hideWindow = true;
    else if (a === "--no-prime") noPrime = true;
    else if (a === "--no-stream") noStream = true;
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
  return { cmd, profileDir, headless, hideWindow, noPrime, noStream, onExit, chatUrl };
}

async function ensureProfileDir(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
}

async function runLogin(profileDir: string): Promise<void> {
  await ensureProfileDir(profileDir);
  console.log(`Launching Chromium with profile: ${profileDir}`);
  console.log(`Opening ${CHAT_URL} — sign in with your ChatGPT account.`);
  const context = await launchChatGptContext(profileDir, false);
  try {
    const page = await openPage(context);
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });
    const rl = readline.createInterface({ input, output });
    await rl.question("When you see the chat UI and are logged in, press Enter here to save and close... ");
    rl.close();
  } finally {
    await context.close();
  }
  console.log("Session saved. Run `npm run repl` or `npm run mira` to talk to Mira.");
}

async function primeCliMode(session: ChatGptSession, skip: boolean): Promise<void> {
  if (skip) return;
  const instructions = loadCliInstructions().trim();
  if (!instructions) return;
  process.stdout.write("Priming Mira (plain-text CLI instructions)... ");
  try {
    await session.send(instructions, { responseTimeoutMs: 180_000 });
    console.log("done.\n");
  } catch (e) {
    console.log(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function runRepl(
  profileDir: string,
  headless: boolean,
  hideWindow: boolean,
  noPrime: boolean,
  noStream: boolean,
  onExit: "none" | "archive" | "delete",
  chatUrl?: string,
): Promise<void> {
  await ensureProfileDir(profileDir);
  let context;
  try {
    context = await launchChatGptContext(profileDir, headless);
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
  await session.openChat(chatUrl);

  if (windowDebugEnabled() && !hideWindow) {
    console.error(
        "[mira] --debug-window logs Win32 hide diagnostics; hiding is off because of --show-window or --no-hide.\n" +
        "[mira] Run without --show-window (default) to hide the browser, e.g. npm run mira -- --debug-window\n",
    );
  }

  if (hideWindow) {
    try {
      const hid = await hideBrowserWindow(page, profileDir);
      if (hid.usedWin32) {
        console.log(
          "(Mira: browser hidden via Windows API — off taskbar / Alt+Tab; /show to restore)\n",
        );
      } else if (hid.usedCdpOffScreen) {
        console.log(
          "(Mira: browser moved off-screen via CDP — may still have a taskbar button; Win32 hide failed or non-Windows.)\n",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Could not hide the browser window: ${msg}\n`);
    }
  }

  await primeCliMode(session, noPrime || Boolean(chatUrl));

  console.log("Mira — type a message, or /help. Ctrl+C to exit.\n");

  const rl = readline.createInterface({ input, output, historySize: 100 });

  try {
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        printHelp();
        continue;
      }
      if (line.startsWith("/name ") || line.startsWith("/rename ")) {
        const title = line.replace(/^\/(name|rename)\s+/, "").trim();
        if (!title) {
          console.log("(usage: /name <new title>)\n");
          continue;
        }
        const ok = await session.renameChat(title);
        console.log(ok ? `(renamed chat)\n` : `(could not rename — check the browser or update selectors)\n`);
        continue;
      }
      if (line === "/name" || line === "/rename") {
        console.log("(usage: /name <new title>)\n");
        continue;
      }
      if (line === "/new") {
        await session.newConversation();
        await primeCliMode(session, noPrime);
        console.log("(new conversation)\n");
        continue;
      }
      if (line === "/show") {
        const ok = await showBrowserWindow(page, profileDir);
        console.log(
          ok
            ? "(Mira: browser window restored)\n"
            : "(Mira: could not restore via Win32 — if the window was only moved off-screen, use the taskbar or Alt+Tab)\n",
        );
        continue;
      }
      if (line === "/debug-window") {
        if (!isWin32()) {
          console.log("(/debug-window is only available on Windows.)\n");
        } else {
          console.log("(see stderr for HWND dump)\n");
          diagnoseBrowserWindows(page, profileDir);
        }
        continue;
      }

      process.stdout.write("mira> ");
      try {
        if (noStream) {
          const reply = await session.send(line);
          console.log(reply + "\n");
        } else {
          let printed = 0;
          const reply = await session.send(line, {
            onAssistantDelta: (full: string) => {
              if (full.length > printed) {
                process.stdout.write(full.slice(printed));
                printed = full.length;
              }
            },
          });
          if (reply.length > printed) process.stdout.write(reply.slice(printed));
          process.stdout.write("\n");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`(error) ${msg}\n`);
      }
    }
  } finally {
    rl.close();
    try {
      if (onExit !== "none") {
        if (hideWindow) await showBrowserWindow(page, profileDir).catch(() => undefined);
        const r = await session.finalizeConversation(onExit);
        if (!r.acted) {
          console.log("\n[mira] No /c/… thread in the address bar — skipped exit cleanup.\n");
        } else if (!r.ok) {
          console.warn(
            "\n[mira] Exit cleanup did not complete (UI may have changed). Finish in the browser if needed.\n" +
              "      Run with --debug-archive (or CHATGPT_REPL_DEBUG_ARCHIVE=1) for stderr traces.\n",
          );
        } else if (onExit === "archive" && r.conversationUrl) {
          console.log("\nArchived. Resume this chat (opens it; brings it back from archive):");
          console.log(`  npm run mira -- --chat-url "${r.conversationUrl}"\n`);
        } else if (onExit === "delete") {
          console.log("\nConversation deleted.\n");
        }
      }
    } catch (e) {
      console.warn("[mira] exit cleanup error:", e instanceof Error ? e.message : String(e));
    }
    await context.close();
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
  );
}

import type { BrowserContext, Page } from "playwright";
import { waitForAssistantTurnImagesReady } from "./assistantImages.js";
import { replDebug, replDebugEnabled } from "./replDebug.js";
import {
  assistantDomResyncMs,
  assistantImageReadyMs,
  composerReadyMs,
  finalizeImageReadyMs,
  replyTailSettleMs,
  responseTimeoutMs,
  stopButtonAppearTimeoutMs,
} from "./replTimeouts.js";
import { assistantBubbleShowsImagePlaceholder } from "./assistantPlaceholder.js";
import {
  archiveOrDeleteActiveConversation,
  assistantMessageLocator,
  clickNewChat,
  findPromptBox,
  parseChatConversationUrl,
  renameActiveConversation,
  scrollConversationIntoView,
  waitForComposerMount,
} from "./selectors.js";

export const CHAT_URL = "https://chatgpt.com/";

async function submitMessage(page: Page): Promise<void> {
  const sendCandidates = [
    page.getByTestId("send-button"),
    page.getByRole("button", { name: /^send$/i }),
    page.locator('button[data-testid*="send"]'),
    page.locator('button[aria-label*="Send"]'),
  ];
  for (const loc of sendCandidates) {
    const b = loc.first();
    if ((await b.count()) === 0) continue;
    const enabled = await b.isEnabled().catch(() => false);
    const visible = await b.isVisible().catch(() => false);
    if (visible && enabled) {
      await b.click();
      return;
    }
  }
  await page.keyboard.press("Enter");
}

async function lastAssistantText(page: Page): Promise<string> {
  const loc = assistantMessageLocator(page);
  const n = await loc.count();
  if (n === 0) return "";
  return (
    await loc.last().evaluate((el: HTMLElement) => {
      const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
      if (!el.querySelector("li")) {
        return norm(el.innerText);
      }

      const out: string[] = [];
      const root = el;

      function emitList(listEl: Element): void {
        for (const child of listEl.children) {
          if (child.tagName.toLowerCase() !== "li") continue;
          const li = child as HTMLElement;
          const c = li.cloneNode(true) as HTMLElement;
          c.querySelectorAll("ul, ol").forEach((u) => u.remove());
          const text = (c.textContent ?? "").replace(/\s+/g, " ").trim();
          let depth = 0;
          let p: Element | null = li.parentElement;
          while (p && p !== root) {
            if (p.tagName === "UL" || p.tagName === "OL") depth++;
            p = p.parentElement;
          }
          if (text.length > 0) out.push(`${"  ".repeat(Math.max(0, depth - 1))}- ${text}`);
          for (const nested of li.querySelectorAll(":scope > ul, :scope > ol")) {
            emitList(nested);
          }
        }
      }

      function walk(node: Node): void {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t.length > 0) out.push(t);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const e = node as Element;
        const tag = e.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          emitList(e);
          return;
        }
        for (const c of e.childNodes) walk(c);
      }

      for (const c of el.childNodes) walk(c);
      return norm(out.join("\n"));
    })
  ).trimEnd();
}

/**
 * Detect **any** change in the latest assistant turn — including image-only replies (empty text).
 * Previously we only compared `lastAssistantText`, which stays `""` for image-only bubbles and matched
 * `before === ""`, so the wait loop never exited.
 */
async function latestAssistantTurnSignature(page: Page): Promise<string> {
  const loc = assistantMessageLocator(page);
  const n = await loc.count();
  if (n === 0) return JSON.stringify({ t: "", i: "", h: -1 });

  const turn = loc.last();
  const text = await lastAssistantText(page);
  const meta = await turn.evaluate((el: HTMLElement) => {
    const imgs = Array.from(el.querySelectorAll("img")).map((node) => {
      const im = node as HTMLImageElement;
      const src = im.currentSrc || im.src || "";
      const nw = im.naturalWidth || im.width || 0;
      const nh = im.naturalHeight || im.height || 0;
      const r = im.getBoundingClientRect();
      return `${nw}x${nh}:${Math.round(r.width)}x${Math.round(r.height)}:${im.complete ? 1 : 0}:${src.length}:${src.slice(0, 80)}`;
    });
    const canvases = Array.from(el.querySelectorAll("canvas")).map((cv) => `${cv.width}x${cv.height}`);
    return {
      i: imgs.join("|"),
      h: el.innerHTML.length,
      c: canvases.join("|"),
    };
  });

  return JSON.stringify({ t: text, i: meta.i, h: meta.h, c: meta.c });
}

/** Signature JSON uses `h:-1` when no `[data-message-author-role=assistant]` nodes match (DOM hole). */
function isVacuumAssistantSig(sig: string): boolean {
  try {
    const o = JSON.parse(sig) as { h?: number };
    return o.h === -1;
  } catch {
    return false;
  }
}

/** ChatGPT sometimes temporarily removes assistant rows from the DOM; avoid `.last()` hangs (~30s each). */
async function waitAssistantTurnPresent(page: Page, maxMs: number): Promise<boolean> {
  const loc = assistantMessageLocator(page);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await scrollConversationIntoView(page);
    const n = await loc.count();
    if (n > 0) return true;
    await page.waitForTimeout(120).catch(() => undefined);
  }
  return false;
}

async function waitForStopHidden(page: Page, timeoutMs: number): Promise<void> {
  const stop = page.getByRole("button", { name: /stop|stop generating/i }).first();
  try {
    await stop.waitFor({ state: "visible", timeout: stopButtonAppearTimeoutMs() });
  } catch {
    /* fast responses may never show Stop */
  }
  await stop.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => undefined);
}

/** Optional callback while the latest assistant message is still being written in the DOM. */
export type AssistantStreamOptions = {
  onDelta?: (fullText: string) => void;
};

/**
 * After the main loop thinks the reply is stable, ChatGPT may still append text or swap `<img>` payloads.
 * Poll until assist signature matches across consecutive reads (capped by time).
 */
async function finalizeAssistantReply(
  page: Page,
  baselineSig: string,
  lastKnownText: string,
  lastKnownSig: string,
  pollMs: number,
  overallDeadline: number,
  emitTextDelta: (s: string) => void,
): Promise<string> {
  const finalizeImgBudget = Math.min(finalizeImageReadyMs(), Math.max(0, overallDeadline - Date.now()));
  if (finalizeImgBudget >= 500) await waitForAssistantTurnImagesReady(page, finalizeImgBudget);

  let curText = lastKnownText;
  let curSig = lastKnownSig;
  let identicalPolls = 0;
  const needIdentical = 5;
  const tailBudget = replyTailSettleMs();
  const tailUntil = Date.now() + tailBudget;

  while (Date.now() < overallDeadline && Date.now() < tailUntil) {
    await page.waitForTimeout(pollMs);
    const nextText = await lastAssistantText(page);
    const nextSig = await latestAssistantTurnSignature(page);
    if (isVacuumAssistantSig(nextSig)) continue;
    emitTextDelta(nextText);
    if (assistantBubbleShowsImagePlaceholder(nextText)) {
      identicalPolls = 0;
      continue;
    }
    if (nextSig === curSig) {
      identicalPolls++;
      if (identicalPolls >= needIdentical) return curText;
    } else {
      curText = nextText;
      curSig = nextSig;
      identicalPolls = 0;
    }
  }

  const snapText = await lastAssistantText(page);
  const snapSig = await latestAssistantTurnSignature(page);
  if (!isVacuumAssistantSig(snapSig)) {
    emitTextDelta(snapText);
    if (!assistantBubbleShowsImagePlaceholder(snapText)) {
      return snapText.length >= curText.length ? snapText : curText;
    }
  }
  return curText;
}

/**
 * After sending, wait until the latest assistant **turn** changes (text and/or images), then until stable.
 * `onDelta` runs when streamed **text** changes; image-only replies may not trigger it.
 */
async function waitForAssistantReply(
  page: Page,
  baselineSig: string,
  timeoutMs: number,
  stream: AssistantStreamOptions = {},
): Promise<string> {
  const onDelta = stream.onDelta;
  const pollStart = onDelta ? 160 : 200;
  const pollTail = onDelta ? 300 : 450;
  const stableNeed = onDelta ? 8 : 3;

  /** Stream assistant text without echoing duplicate strings; skip initial empty scrape. */
  let lastStreamedText: string | null = null;
  const emitTextDelta = (fullText: string) => {
    if (!onDelta) return;
    if (lastStreamedText !== null && fullText === lastStreamedText) return;
    if (lastStreamedText === null && fullText === "") {
      lastStreamedText = "";
      return;
    }
    lastStreamedText = fullText;
    onDelta(fullText);
  };

  const deadline = Date.now() + timeoutMs;
  replDebug("waitForAssistantReply: start", {
    timeoutMs,
    baselineSigLen: baselineSig.length,
    debugLogFile: process.env.MIRA_DEBUG_REPL_FILE?.trim() || null,
  });

  let firstLoopIters = 0;
  let lastFirstLogAt = 0;
  let confirmedSig: string | null = null;

  while (Date.now() < deadline) {
    firstLoopIters++;
    const sig = await latestAssistantTurnSignature(page);
    if (sig !== baselineSig) {
      const curText = await lastAssistantText(page);
      emitTextDelta(curText);
      confirmedSig = sig;
      replDebug("waitForAssistantReply: first turn delta", {
        iters: firstLoopIters,
        textLen: curText.length,
        imgFingerPrint: sig.slice(0, 240),
      });
      break;
    }
    if (replDebugEnabled() && Date.now() - lastFirstLogAt > 4_000) {
      lastFirstLogAt = Date.now();
      const curText = await lastAssistantText(page);
      replDebug("waitForAssistantReply: waiting first turn delta", {
        iters: firstLoopIters,
        textLen: curText.length,
        sigUnchanged: true,
      });
    }
    await page.waitForTimeout(pollStart);
  }

  if (!confirmedSig) {
    replDebug("waitForAssistantReply: timed out before assistant turn changed");
    throw new Error(
      "Timed out waiting for an assistant reply. Check the browser window: login, captcha, or UI changes.",
    );
  }

  const budgetAfterFirst = Math.max(5_000, deadline - Date.now());
  replDebug("waitForAssistantReply: wait stop generating…", { budgetMs: budgetAfterFirst });
  await waitForStopHidden(page, budgetAfterFirst);
  replDebug("waitForAssistantReply: stop hidden (or timed waiting visible)");

  const resyncMs = assistantDomResyncMs();
  const domOk = await waitAssistantTurnPresent(page, resyncMs);
  replDebug("waitForAssistantReply: DOM resync assistant row", { ok: domOk, budgetMs: resyncMs });
  if (!domOk) {
    replDebug(
      "waitForAssistantReply: WARNING — no assistant DOM nodes matched selectors after Stop; stability may spin until timeout (ChatGPT UI change?).",
    );
  }

  const postStopImgMs = Math.min(assistantImageReadyMs(), Math.max(0, deadline - Date.now()));
  if (postStopImgMs >= 500) await waitForAssistantTurnImagesReady(page, postStopImgMs);
  replDebug("waitForAssistantReply: post-stop image idle done");

  let lastTxt = await lastAssistantText(page);
  let lastFp = await latestAssistantTurnSignature(page);
  if (isVacuumAssistantSig(lastFp)) {
    replDebug("waitForAssistantReply: stability entry fingerprint still vacuum after resync");
  }
  emitTextDelta(lastTxt);
  replDebug("waitForAssistantReply: stability poll phase", {
    textLen: lastTxt.length,
    fpPrefix: lastFp.slice(0, 180),
  });

  let stableTicks = 0;
  let lastStuckLog = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollTail);
    const fp = await latestAssistantTurnSignature(page);
    const txt = await lastAssistantText(page);
    if (isVacuumAssistantSig(fp)) {
      const now = Date.now();
      if (now - lastStuckLog > 8_000) {
        lastStuckLog = now;
        if (replDebugEnabled()) {
          replDebug("waitForAssistantReply: vacuum fingerprint tick (assistant DOM gap)");
        }
        await scrollConversationIntoView(page);
      }
      continue;
    }
    emitTextDelta(txt);
    if (assistantBubbleShowsImagePlaceholder(txt)) {
      stableTicks = 0;
      lastFp = fp;
      continue;
    }
    if (fp === lastFp) {
      stableTicks++;
      if (replDebugEnabled()) {
        const now = Date.now();
        if (now - lastStuckLog > 12_000) {
          lastStuckLog = now;
          replDebug("waitForAssistantReply: polling", {
            stableTicks,
            need: stableNeed,
            textLen: txt.length,
            fpStable: true,
          });
        }
      }
      if (stableTicks >= stableNeed) {
        replDebug("waitForAssistantReply: fingerprint stable → finalize");
        return finalizeAssistantReply(page, baselineSig, txt, fp, pollTail, deadline, emitTextDelta);
      }
    } else {
      stableTicks = 0;
      lastFp = fp;
      lastTxt = txt;
    }
  }

  const outTxt = await lastAssistantText(page);
  const outFp = await latestAssistantTurnSignature(page);
  emitTextDelta(outTxt);
  if (!isVacuumAssistantSig(outFp)) {
    replDebug("waitForAssistantReply: deadline tail return");
    return outTxt.length >= lastTxt.length ? outTxt : lastTxt;
  }
  replDebug("waitForAssistantReply: timed out");
  throw new Error(
    "Timed out waiting for an assistant reply. Check the browser window: login, captcha, or UI changes.",
  );
}

export class ChatGptSession {
  constructor(
    private readonly page: Page,
    private readonly headless: boolean,
  ) {}

  async openChat(
    startUrl?: string,
    hooks?: { afterNavigate?: () => Promise<void> },
  ): Promise<void> {
    const target = (startUrl?.trim() || CHAT_URL).trim();
    const deepThread = /\/c\/[^/?#]+/.test(new URL(target, "https://chatgpt.com/").pathname);
    await this.page.goto(target, { waitUntil: deepThread ? "load" : "domcontentloaded" });
    if (hooks?.afterNavigate) {
      await hooks.afterNavigate();
    }
    try {
      await waitForComposerMount(this.page, composerReadyMs());
    } catch (e) {
      const hint = this.headless
        ? " Headless runs are often blocked; try without --headless, or set CHATGPT_REPL_CHANNEL=chrome to use your installed Google Chrome."
        : "";
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg}${hint}`);
    }
  }

  async newConversation(): Promise<void> {
    await clickNewChat(this.page);
    await waitForComposerMount(this.page, composerReadyMs());
  }

  /** Set the chat title via the web UI (⋯ → Rename). */
  async renameChat(title: string): Promise<boolean> {
    return renameActiveConversation(this.page, title);
  }

  /**
   * Sends `text` in the current conversation and returns the latest assistant reply.
   * Pass `onAssistantDelta` to receive growing `innerText` of the latest reply while it streams in the page.
   */
  async send(
    text: string,
    opts: { responseTimeoutMs?: number; onAssistantDelta?: (fullText: string) => void } = {},
  ): Promise<string> {
    const timeoutMs = opts.responseTimeoutMs ?? responseTimeoutMs();
    const stream: AssistantStreamOptions =
      opts.onAssistantDelta !== undefined ? { onDelta: opts.onAssistantDelta } : {};

    const page = this.page;
    const baselineSig = await latestAssistantTurnSignature(page);

    const box = await findPromptBox(page);
    await box.scrollIntoViewIfNeeded().catch(() => undefined);
    try {
      await box.click({ timeout: 8_000 });
    } catch {
      try {
        await box.click({ force: true, timeout: 5_000 });
      } catch {
        await box.focus({ timeout: 8_000 });
      }
    }
    try {
      await box.fill(text);
    } catch {
      await box.evaluate((el, value) => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.isContentEditable) {
          htmlEl.innerText = value;
          htmlEl.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        }
      }, text);
    }

    await submitMessage(page);
    return waitForAssistantReply(page, baselineSig, timeoutMs, stream);
  }

  /**
   * Delete or archive the current `/c/…` conversation via the web UI. Captures the canonical URL first.
   */
  async finalizeConversation(
    mode: "delete" | "archive",
  ): Promise<{ ok: boolean; conversationUrl: string | null; acted: boolean }> {
    const conversationUrl = parseChatConversationUrl(this.page.url());
    if (!conversationUrl) return { ok: true, conversationUrl: null, acted: false };
    const ok = await archiveOrDeleteActiveConversation(this.page, mode);
    return { ok, conversationUrl, acted: true };
  }
}

export async function openPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) return existing;
  return context.newPage();
}

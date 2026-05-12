import type { BrowserContext, Page } from "playwright";
import {
  archiveOrDeleteActiveConversation,
  assistantMessageLocator,
  clickNewChat,
  findPromptBox,
  parseChatConversationUrl,
  renameActiveConversation,
  waitForComposerMount,
} from "./selectors.js";

export const CHAT_URL = "https://chatgpt.com/";

const COMPOSER_READY_MS = 120_000;

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
    await loc.nth(n - 1).evaluate((el: HTMLElement) => {
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

async function waitForStopHidden(page: Page, timeoutMs: number): Promise<void> {
  const stop = page.getByRole("button", { name: /stop|stop generating/i }).first();
  try {
    await stop.waitFor({ state: "visible", timeout: 25_000 });
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
 * After the main loop thinks the reply is stable, ChatGPT may still append text in short bursts.
 * Poll until the last assistant `innerText` is unchanged for several consecutive reads (capped by time).
 */
async function finalizeAssistantReply(
  page: Page,
  before: string,
  lastKnown: string,
  pollMs: number,
  overallDeadline: number,
  emit: (s: string) => void,
): Promise<string> {
  let cur = lastKnown;
  let identicalPolls = 0;
  const needIdentical = 5;
  const tailBudget = 6_000;
  const tailUntil = Date.now() + tailBudget;

  while (Date.now() < overallDeadline && Date.now() < tailUntil) {
    await page.waitForTimeout(pollMs);
    const next = await lastAssistantText(page);
    if (!next || next === before) continue;
    emit(next);
    if (next === cur) {
      identicalPolls++;
      if (identicalPolls >= needIdentical) return cur;
    } else {
      cur = next;
      identicalPolls = 0;
    }
  }

  const snap = await lastAssistantText(page);
  if (snap && snap !== before) {
    emit(snap);
    return snap.length >= cur.length ? snap : cur;
  }
  return cur;
}

/**
 * After sending, wait until the last assistant message differs from `before` and text stops changing.
 * If `onDelta` is set, it is called whenever the latest assistant text changes (polling DOM).
 */
async function waitForAssistantReply(
  page: Page,
  before: string,
  timeoutMs: number,
  stream: AssistantStreamOptions = {},
): Promise<string> {
  const onDelta = stream.onDelta;
  const pollStart = onDelta ? 160 : 200;
  const pollTail = onDelta ? 300 : 450;
  const stableNeed = onDelta ? 8 : 3;

  const emit = (cur: string) => {
    if (onDelta && cur && cur !== before) onDelta(cur);
  };

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const cur = await lastAssistantText(page);
    emit(cur);
    if (cur && cur !== before) break;
    await page.waitForTimeout(pollStart);
  }

  const budgetAfterFirst = Math.max(5_000, deadline - Date.now());
  await waitForStopHidden(page, budgetAfterFirst);

  let last = await lastAssistantText(page);
  emit(last);
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollTail);
    const cur = await lastAssistantText(page);
    if (!cur || cur === before) continue;
    emit(cur);
    if (cur === last) {
      stableTicks++;
      if (stableTicks >= stableNeed) {
        return finalizeAssistantReply(page, before, cur, pollTail, deadline, emit);
      }
    } else {
      stableTicks = 0;
      last = cur;
    }
  }

  const out = await lastAssistantText(page);
  emit(out);
  if (out && out !== before) {
    return out.length >= last.length ? out : last;
  }
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
      await waitForComposerMount(this.page, COMPOSER_READY_MS);
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
    await waitForComposerMount(this.page, COMPOSER_READY_MS);
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
    const timeoutMs = opts.responseTimeoutMs ?? 240_000;
    const stream: AssistantStreamOptions =
      opts.onAssistantDelta !== undefined ? { onDelta: opts.onAssistantDelta } : {};

    const page = this.page;
    const before = await lastAssistantText(page);

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
    return waitForAssistantReply(page, before, timeoutMs, stream);
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

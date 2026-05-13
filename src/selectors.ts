import type { Locator, Page } from "playwright";

/** Set `CHATGPT_REPL_DEBUG_ARCHIVE=1` or pass `--debug-archive` for stderr traces during --on-exit. */
export function archiveDebugEnabled(): boolean {
  return process.env.CHATGPT_REPL_DEBUG_ARCHIVE === "1";
}

function archiveDbg(...args: unknown[]): void {
  if (!archiveDebugEnabled()) return;
  console.error("[mira/archive]", ...args);
}

/**
 * ChatGPT's DOM changes frequently. These are ordered fallback strategies.
 * The live composer is usually a ProseMirror `div#prompt-textarea`; a `textarea` may exist for
 * accessibility but sit *under* the contenteditable and intercept pointer checks — avoid clicking it.
 */

/** Archive / system banners can sit above the composer until dismissed. */
async function tryDismissArchiveOrBlockingUi(page: Page): Promise<void> {
  const builders: Array<() => ReturnType<Page["getByRole"]>> = [
    () => page.getByRole("button", { name: /^unarchive$/i }),
    () => page.getByRole("button", { name: /unarchive chat/i }),
    () => page.getByRole("button", { name: /^restore$/i }),
    () => page.getByRole("button", { name: /restore chat/i }),
    () => page.getByRole("button", { name: /move to (my )?chats?/i }),
    () => page.getByRole("link", { name: /unarchive/i }),
    () => page.getByRole("button", { name: /^got it$/i }),
    () => page.getByRole("button", { name: /continue( with)? (this )?chat/i }),
  ];
  for (const make of builders) {
    const hit = make().first();
    if ((await hit.count()) === 0) continue;
    if (!(await hit.isVisible().catch(() => false))) continue;
    await hit.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(550);
    return;
  }
  const loose = page.locator("button").filter({ hasText: /^unarchive$/i }).first();
  if ((await loose.count()) > 0 && (await loose.isVisible().catch(() => false))) {
    await loose.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(550);
  }
}

export async function waitForComposerMount(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await tryDismissArchiveOrBlockingUi(page);
    try {
      const strategies: Locator[] = [
        page.locator('div#prompt-textarea[contenteditable="true"]').first(),
        page.locator('div#prompt-textarea[role="textbox"]').first(),
        page.locator("div#prompt-textarea").first(),
      ];
      for (const loc of strategies) {
        if ((await loc.count()) === 0) continue;
        try {
          await loc.waitFor({ state: "attached", timeout: 2_500 });
        } catch (e) {
          lastErr = e;
          continue;
        }
        if (await isUsablePrompt(loc)) return;
      }
    } catch (e) {
      lastErr = e;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    `No composer appeared within ${timeoutMs / 1000}s. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function isUsablePrompt(loc: Locator): Promise<boolean> {
  if ((await loc.count()) === 0) return false;
  const first = loc.first();
  if (await first.isVisible().catch(() => false)) return true;
  const box = await first.boundingBox().catch(() => null);
  return !!box && box.width > 16 && box.height > 8;
}

export async function findPromptBox(page: Page): Promise<Locator> {
  const strategies: Array<() => Locator> = [
    () => page.locator('div#prompt-textarea[contenteditable="true"]'),
    () => page.getByRole("textbox", { name: /chat with chatgpt/i }),
    () => page.locator('div#prompt-textarea[role="textbox"]'),
    () => page.locator("div#prompt-textarea"),
    () => page.getByRole("textbox", { name: /message|ask anything/i }),
    () => page.locator('div[contenteditable="true"][data-virtualkeyboard="true"]').last(),
    () => page.locator('div.ProseMirror[contenteditable="true"]').last(),
  ];
  for (const make of strategies) {
    try {
      const loc = make().first();
      if (await isUsablePrompt(loc)) {
        await loc.scrollIntoViewIfNeeded().catch(() => undefined);
        return loc;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Could not find the message composer. ChatGPT may have changed its UI — update src/selectors.ts",
  );
}

export function assistantMessageLocator(page: Page): Locator {
  return page.locator(
    [
      '[data-message-author-role="assistant"]',
      '[data-testid="conversation-turn-assistant"]',
      'div[data-role="assistant"]',
    ].join(", "),
  );
}

export async function clickNewChat(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("link", { name: /^new chat$/i }),
    page.getByRole("button", { name: /^new chat$/i }),
    page.getByRole("button", { name: /^new conversation$/i }),
  ];
  for (const loc of candidates) {
    const hit = loc.first();
    if ((await hit.count()) > 0 && (await hit.isVisible().catch(() => false))) {
      await hit.click();
      await page.waitForTimeout(800);
      return;
    }
  }
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
}

/** Canonical https URL for a /c/… thread, or null if `pageUrl` is not a normal chat thread. */
export function parseChatConversationUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "chatgpt.com" && host !== "chat.openai.com") return null;
    const m = u.pathname.match(/^\/c\/([^/?#]+)/);
    if (!m || m[1].length < 4) return null;
    return `https://${host}/c/${m[1]}`;
  } catch {
    return null;
  }
}

/** Best-effort thread title from the tab / header (for chat history metadata). */
export async function readActiveConversationTitle(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const stripTitle = (s: string) =>
        s
          .replace(/\s*[·•]\s*ChatGPT\s*$/i, "")
          .replace(/\s*-\s*ChatGPT\s*$/i, "")
          .replace(/\s*\|\s*ChatGPT\s*$/i, "")
          .trim();

      const dt = stripTitle(document.title || "");
      if (dt && dt.toLowerCase() !== "chatgpt") return dt;

      const headerSelectors = [
        '[data-testid="conversation-header"]',
        '[data-testid="chat-header"]',
        "main header",
      ];
      for (const sel of headerSelectors) {
        const root = document.querySelector(sel);
        if (!root) continue;
        const h = root.querySelector("h1, h2");
        if (h) {
          const t = (h.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.toLowerCase() !== "chatgpt") return t;
        }
      }

      const mainH1 = document.querySelector("main h1");
      if (mainH1) {
        const t = (mainH1.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.toLowerCase() !== "chatgpt") return t;
      }

      return null;
    });
  } catch {
    return null;
  }
}

async function clickWithHiddenUi(loc: Locator, page: Page): Promise<void> {
  if ((await loc.count()) === 0) return;
  const first = loc.first();
  try {
    await first.click({ timeout: 4_000 });
  } catch (e) {
    archiveDbg("click failed, retrying force:", e instanceof Error ? e.message : e);
    await first.click({ force: true, timeout: 5_000 });
  }
  await page.waitForTimeout(200);
}

async function archiveLogMenuDomSnapshot(page: Page, label: string): Promise<void> {
  if (!archiveDebugEnabled()) return;
  try {
    const info = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
      return {
        menuCount: document.querySelectorAll('[role="menu"]').length,
        menuitemCount: document.querySelectorAll('[role="menuitem"]').length,
        listboxCount: document.querySelectorAll('[role="listbox"]').length,
        popperCount: document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
        items: items.slice(0, 24).map((el) => ({
          role: el.getAttribute("role"),
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
          aria: (el.getAttribute("aria-label") || "").slice(0, 80),
        })),
      };
    });
    archiveDbg(`${label} DOM snapshot:`, JSON.stringify(info, null, 2));
  } catch (e) {
    archiveDbg(`${label} DOM snapshot failed:`, e instanceof Error ? e.message : e);
  }
}

async function menuOpened(page: Page): Promise<boolean> {
  const menu = page.getByRole("menu");
  if ((await menu.count()) > 0 && (await menu.first().isVisible().catch(() => false))) return true;
  const listbox = page.getByRole("listbox");
  if ((await listbox.count()) > 0 && (await listbox.first().isVisible().catch(() => false))) return true;
  if ((await page.getByRole("menuitem").count()) > 0) {
    const mi = page.getByRole("menuitem").first();
    if (await mi.isVisible().catch(() => false)) return true;
  }
  const pop = page.locator('[data-radix-popper-content-wrapper], [data-state="open"]').filter({
    has: page.locator('[role="menu"], [role="menuitem"]'),
  });
  if ((await pop.count()) > 0 && (await pop.first().isVisible().catch(() => false))) return true;
  const radixContent = page.locator("[data-radix-dropdown-menu-content], [data-radix-menu-content]");
  if ((await radixContent.count()) > 0 && (await radixContent.first().isVisible().catch(() => false))) return true;
  /* Headed-but-hidden: Radix portals mount before visibility flips. */
  if ((await radixContent.count()) > 0) return true;
  /* Headed-but-hidden browser: popovers may exist without Playwright "visible" heuristics. */
  if ((await page.getByRole("menuitem").count()) > 0) return true;
  return false;
}

async function dispatchMenuTriggerClick(loc: Locator, page: Page): Promise<void> {
  const el = loc.first();
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  await el.dispatchEvent("click", { bubbles: true });
  await page.waitForTimeout(350);
}

/**
 * Sidebar history row uses `data-conversation-options-trigger="<uuid>"`; the chat title `<a>` sits on
 * top and intercepts normal Playwright clicks — use dispatchEvent / pointer events.
 */
async function openViaConversationOptionsTrigger(
  page: Page,
  conversationId: string,
): Promise<boolean> {
  const trigger = page.locator(`button[data-conversation-options-trigger="${conversationId}"]`).first();
  if ((await trigger.count()) === 0) {
    archiveDbg(`data-conversation-options-trigger=${conversationId}: no button`);
    return false;
  }
  archiveDbg(`data-conversation-options-trigger=${conversationId}: dispatch click`);
  await dispatchMenuTriggerClick(trigger, page);
  if (await menuOpened(page)) return true;

  archiveDbg(`data-conversation-options-trigger: retry pointerdown/up`);
  const el = trigger.first();
  await el.dispatchEvent("pointerdown", { bubbles: true, button: 0 });
  await el.dispatchEvent("pointerup", { bubbles: true, button: 0 });
  await el.dispatchEvent("click", { bubbles: true });
  await page.waitForTimeout(400);
  if (await menuOpened(page)) return true;

  archiveDbg(`data-conversation-options-trigger: retry element.click()`);
  const clicked = await trigger.evaluate((node) => {
    const b = node as HTMLButtonElement;
    b.click();
    return true;
  });
  archiveDbg(`evaluate .click() ran=${clicked}`);
  await page.waitForTimeout(400);
  return menuOpened(page);
}

async function openViaHeaderMenu(page: Page): Promise<boolean> {
  const openers: Array<[string, Locator]> = [
    ["getByTestId(conversation-menu-button)", page.getByTestId("conversation-menu-button")],
    ["locator([data-testid=conversation-menu-button])", page.locator('[data-testid="conversation-menu-button"]')],
    [
      "role=button main chat menu (excludes sidebar history-item)",
      page
        .getByRole("button", {
          name: /open conversation menu|chat options|more actions|^options$/i,
        })
        .filter({ hasNot: page.locator('[data-testid^="history-item-"]') }),
    ],
    ["aria-label *conversation* *menu*", page.locator('button[aria-label*="conversation"][aria-label*="menu" i]')],
    ["aria-label Open chat menu", page.locator('button[aria-label*="Open chat menu" i]')],
    ["conversation-toolbar [aria-haspopup=menu]", page.locator('[data-testid="conversation-toolbar"] button[aria-haspopup="menu"]').first()],
    [
      "main shell [aria-haspopup=menu] (not sidebar)",
      page
        .locator(
          'header button[aria-haspopup="menu"]:not([data-testid^="history-item-"]), [data-testid="conversation-header"] button[aria-haspopup="menu"]',
        )
        .last(),
    ],
    [
      "nav [aria-haspopup=menu] (first, not history row)",
      page.locator('nav button[aria-haspopup="menu"]:not([data-testid^="history-item-"])').first(),
    ],
  ];
  for (let i = 0; i < openers.length; i++) {
    const [label, b] = openers[i];
    const hit = b.first();
    if ((await hit.count()) === 0) {
      archiveDbg(`header opener[${i}] ${label}: no matching node`);
      continue;
    }
    archiveDbg(`header opener[${i}] ${label}: click`);
    await clickWithHiddenUi(hit, page);
    const opened = await menuOpened(page);
    archiveDbg(`header opener[${i}] menuOpened=${opened}`);
    if (opened) return true;
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
  }
  return false;
}

async function openSidebarIfNeeded(page: Page): Promise<void> {
  const toggles = [
    page.getByRole("button", { name: /open sidebar|show sidebar|toggle sidebar|open history|chat history/i }),
    page.getByRole("button", { name: /^menu$/i }),
  ];
  for (const t of toggles) {
    const b = t.first();
    if ((await b.count()) > 0 && (await b.isVisible().catch(() => false))) {
      await b.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      return;
    }
  }
}

async function openViaSidebarRow(page: Page, conversationPath: string): Promise<boolean> {
  const id = conversationPath.replace(/^\/c\//, "");
  archiveDbg(`sidebar: conversation id=${id}`);
  await openSidebarIfNeeded(page);

  if (await openViaConversationOptionsTrigger(page, id)) {
    archiveDbg("sidebar: opened via data-conversation-options-trigger");
    return true;
  }

  const links = page.locator(
    `aside a[href="/c/${id}"], nav a[href="/c/${id}"], a[href$="/c/${id}"], a[href*="/c/${id}"]`,
  );
  const nLinks = await links.count();
  archiveDbg(`sidebar: link matches count=${nLinks}`);
  const link = links.first();
  if ((await link.count()) === 0) return false;
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.hover({ timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const rowMenu = link
    .locator("xpath=ancestor::li[1] | ancestor::div[contains(@class,'group')][1]")
    .locator('button[aria-haspopup="menu"], button[aria-expanded]')
    .first();
  const rowMenuN = await rowMenu.count();
  archiveDbg(`sidebar: row overflow button count=${rowMenuN}`);
  if (rowMenuN > 0) {
    await dispatchMenuTriggerClick(rowMenu, page);
    if (!(await menuOpened(page))) {
      await clickWithHiddenUi(rowMenu, page);
    }
    const opened = await menuOpened(page);
    archiveDbg(`sidebar: after row overflow click menuOpened=${opened}`);
    if (opened) return true;
  }
  const nearby = page
    .locator(`a[href="/c/${id}"] >> xpath=../button | a[href="/c/${id}"] >> xpath=..//button[@aria-haspopup]`)
    .first();
  if ((await nearby.count()) > 0) {
    await clickWithHiddenUi(nearby, page);
    await page.waitForTimeout(200);
    if (await menuOpened(page)) return true;
  }
  return false;
}

async function openConversationActionsMenu(page: Page, conversationPath: string): Promise<boolean> {
  const id = conversationPath.replace(/^\/c\//, "");
  archiveDbg("openSidebarIfNeeded (so history row trigger can be present)…");
  await openSidebarIfNeeded(page);
  archiveDbg("trying data-conversation-options-trigger (sidebar row)…");
  if (await openViaConversationOptionsTrigger(page, id)) {
    archiveDbg("opened via data-conversation-options-trigger");
    return true;
  }
  archiveDbg("trying header conversation menu…");
  if (await openViaHeaderMenu(page)) {
    archiveDbg("opened via header");
    return true;
  }
  archiveDbg("trying sidebar row fallbacks…");
  const side = await openViaSidebarRow(page, conversationPath);
  archiveDbg(`sidebar fallbacks result=${side}`);
  return side;
}

async function confirmDeleteDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await dialog.first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  const names = [
    page.getByRole("button", { name: /^(delete forever|delete permanently|permanently delete|confirm|delete chat)$/i }),
    page.getByRole("button", { name: /^delete$/i }),
  ];
  for (const loc of names) {
    const btn = loc.last();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 8_000 });
      return;
    }
  }
}

/**
 * Archive or delete the **current** conversation using the web UI (sidebar or header menu).
 * Best-effort: ChatGPT changes often; extend selectors if this regresses.
 */
export async function archiveOrDeleteActiveConversation(
  page: Page,
  mode: "archive" | "delete",
): Promise<boolean> {
  archiveDbg(`start mode=${mode} url=${page.url()}`);
  await page.bringToFront().catch((e) => archiveDbg("bringToFront failed:", e));

  const u = new URL(page.url());
  const path = u.pathname.match(/^\/c\/[^/?#]+/);
  if (!path) {
    archiveDbg("no /c/… path in URL — cannot archive/delete");
    return false;
  }
  archiveDbg(`conversation path=${path[0]}`);

  const opened = await openConversationActionsMenu(page, path[0]);
  if (!opened) {
    archiveDbg("FAILED: could not open conversation overflow menu");
    await archiveLogMenuDomSnapshot(page, "after menu open failure");
    return false;
  }

  await archiveLogMenuDomSnapshot(page, "menu open ok");

  await page.locator('[role="menu"], [data-radix-popper-content-wrapper]').first().waitFor({
    state: "attached",
    timeout: 6_000,
  }).catch((e) => archiveDbg("wait for menu container attached:", e));
  await page.waitForTimeout(200);

  const arch = mode === "archive";
  const locators: Locator[] = arch
    ? [
        page.getByRole("menuitem", { name: /^move to archive$/i }),
        page.getByRole("menuitem", { name: /^archive$/i }),
        page.getByRole("menuitem", { name: /archive chat/i }),
        page.getByRole("button", { name: /^move to archive$/i }),
        page.getByRole("button", { name: /^archive$/i }),
      ]
    : [
        page.getByRole("menuitem", { name: /^delete$/i }),
        page.getByRole("menuitem", { name: /delete chat/i }),
        page.getByRole("button", { name: /^delete$/i }),
      ];

  const locatorLabels = arch
    ? [
        "menuitem ^move to archive$",
        "menuitem ^archive$",
        "menuitem archive chat",
        "button ^move to archive$",
        "button ^archive$",
      ]
    : ["menuitem ^delete$", "menuitem delete chat", "button ^delete$"];

  let clicked = false;
  let usedLocator = "";
  for (let li = 0; li < locators.length; li++) {
    const loc = locators[li];
    if ((await loc.count()) === 0) {
      archiveDbg(`action locator[${li}] ${locatorLabels[li]}: count=0`);
      continue;
    }
    const hit = loc.first();
    const vis = await hit.isVisible().catch(() => false);
    archiveDbg(`action locator[${li}] ${locatorLabels[li]}: count>=1 visible=${vis}`);
    try {
      if (vis) await hit.click({ timeout: 6_000 });
      else await hit.click({ force: true, timeout: 6_000 });
      clicked = true;
      usedLocator = locatorLabels[li];
      break;
    } catch (e1) {
      archiveDbg(`action locator[${li}] click failed:`, e1 instanceof Error ? e1.message : e1);
      try {
        await hit.click({ force: true, timeout: 6_000 });
        clicked = true;
        usedLocator = `${locatorLabels[li]} (force retry)`;
        break;
      } catch (e2) {
        archiveDbg(`action locator[${li}] force retry failed:`, e2 instanceof Error ? e2.message : e2);
      }
    }
  }

  if (!clicked) {
    if (arch) {
      const byText = page.getByText(/^Move to archive$/i).or(page.getByText(/^Archive$/i)).first();
      const n = await byText.count();
      archiveDbg(`fallback getByText Archive / Move to archive: count=${n}`);
      if (n > 0) {
        await clickWithHiddenUi(byText, page);
        clicked = true;
        usedLocator = "getByText Archive/Move to archive";
      }
    }
  }

  let usedEvaluate = false;
  if (!clicked) {
    archiveDbg("trying DOM evaluate fallback for menuitem/option/button…");
    clicked = await page.evaluate((kind) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const nodes = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="option"], button, a'),
      ) as HTMLElement[];
      for (const el of nodes) {
        const t = norm(el.textContent || el.getAttribute("aria-label") || "");
        if (!t) continue;
        if (kind === "archive") {
          if (t === "archive" || t === "move to archive" || t.includes("move to archive")) {
            el.click();
            return true;
          }
        } else {
          if (t === "delete" || t.includes("delete chat")) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, mode);
    if (clicked) usedEvaluate = true;
    archiveDbg(`evaluate fallback clicked=${clicked}`);
  }

  if (!clicked) {
    archiveDbg("FAILED: no archive/delete control clicked");
    await archiveLogMenuDomSnapshot(page, "after action click failure");
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  archiveDbg(`action clicked ok via ${usedEvaluate ? "evaluate" : usedLocator || "unknown"}`);

  if (mode === "delete") {
    await confirmDeleteDialog(page);
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(600);
  archiveDbg(`end mode=${mode} url=${page.url()} (done)`);
  return true;
}

/**
 * Rename the current `/c/…` chat via ⋯ → Rename (best effort).
 */
export async function renameActiveConversation(page: Page, rawTitle: string): Promise<boolean> {
  const newTitle = rawTitle.trim();
  if (!newTitle) return false;

  await page.bringToFront().catch(() => undefined);
  const u = new URL(page.url());
  const path = u.pathname.match(/^\/c\/[^/?#]+/);
  if (!path) return false;

  const opened = await openConversationActionsMenu(page, path[0]);
  if (!opened) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  await page.waitForTimeout(200);

  const renameCandidates: Locator[] = [
    page.getByRole("menuitem", { name: /^rename$/i }),
    page.getByRole("menuitem", { name: /rename chat/i }),
    page.getByRole("button", { name: /^rename$/i }),
  ];

  let menuClicked = false;
  for (const loc of renameCandidates) {
    if ((await loc.count()) === 0) continue;
    const hit = loc.first();
    try {
      await hit.click({ force: true, timeout: 5_000 });
      menuClicked = true;
      break;
    } catch {
      try {
        await hit.dispatchEvent("click", { bubbles: true });
        menuClicked = true;
        break;
      } catch {
        /* next */
      }
    }
  }

  if (!menuClicked) {
    const ev = await page.evaluate(() => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const nodes = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="option"]'),
      ) as HTMLElement[];
      for (const el of nodes) {
        const t = norm(el.textContent || el.getAttribute("aria-label") || "");
        if (t === "rename" || t.startsWith("rename")) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!ev) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
  }

  await page.waitForTimeout(300);

  const tryFill = async (box: Locator): Promise<boolean> => {
    if ((await box.count()) === 0) return false;
    const b = box.first();
    try {
      await b.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      return false;
    }
    try {
      await b.click({ timeout: 4_000 }).catch(() => undefined);
      await b.fill(newTitle);
      await page.keyboard.press("Enter");
      return true;
    } catch {
      /* try programmatic set */
    }
    try {
      const ok = await b.evaluate((el, value) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        const h = el as HTMLElement;
        if (h.isContentEditable) {
          h.focus();
          h.innerText = value;
          h.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
          return true;
        }
        return false;
      }, newTitle);
      if (!ok) return false;
      await page.keyboard.press("Enter");
      return true;
    } catch {
      return false;
    }
  };

  const inputStrategies: Locator[] = [
    page.getByRole("dialog").getByRole("textbox"),
    page.locator('[role="dialog"] input[type="text"]'),
    page.locator('aside input[type="text"]:visible'),
    page.locator('input[type="text"]:visible'),
    page.getByPlaceholder(/chat name|conversation name|name/i),
    page.locator('[data-testid*="rename" i] input'),
  ];

  let filled = false;
  for (const loc of inputStrategies) {
    if (await tryFill(loc)) {
      filled = true;
      break;
    }
  }

  if (!filled) {
    const ce = page.locator('[role="dialog"] [contenteditable="true"]').first();
    filled = await tryFill(ce);
  }

  await page.waitForTimeout(400);
  await page.keyboard.press("Escape").catch(() => undefined);
  return filled;
}

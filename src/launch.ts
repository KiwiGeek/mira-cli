import { chromium, type BrowserContext } from "playwright";

const STEALTH_INIT = `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  } catch (_) {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", { value: { runtime: {} }, configurable: true });
    }
  } catch (_) {}
})();`;

/**
 * Launch options tuned so headless runs are less likely to get a “lite” / blocked shell of chatgpt.com.
 */
export async function launchChatGptContext(
  userDataDir: string,
  headless: boolean,
): Promise<BrowserContext> {
  const channel = process.env.CHATGPT_REPL_CHANNEL as "chrome" | "msedge" | "chromium" | undefined;
  const useChannel =
    channel === "chrome" || channel === "msedge" ? { channel } : {};

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    ...useChannel,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });
  await context.addInitScript(STEALTH_INIT);
  return context;
}

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
 *
 * @param spawnOffScreen When true and not headless, Chromium opens with the window positioned far off-screen
 *        so it should not flash on the primary monitor before Win32/CDP hide runs.
 */
export async function launchChatGptContext(
  userDataDir: string,
  headless: boolean,
  opts?: { spawnOffScreen?: boolean },
): Promise<BrowserContext> {
  const channel = process.env.CHATGPT_REPL_CHANNEL as "chrome" | "msedge" | "chromium" | undefined;
  const useChannel =
    channel === "chrome" || channel === "msedge" ? { channel } : {};

  const offScreen =
    opts?.spawnOffScreen === true && !headless ? ["--window-position=-32000,-32000"] : [];

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
      ...offScreen,
    ],
  });
  await context.addInitScript(STEALTH_INIT);
  return context;
}

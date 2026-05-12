import type { Page } from "playwright";
import {
  diagnoseBrowserWindows,
  hideBrowserWindowWin32,
  isWin32,
  showBrowserWindowWin32,
  windowDebugEnabled,
} from "./win32Window.js";

type TargetInfo = { targetId: string; type: string; attached: boolean; url?: string };

/** Move browser window far off-screen. Does not minimize (minimize still pins to the taskbar on Windows). */
async function hideBrowserWindowCdpOffScreen(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);

  const targets = (await session.send("Target.getTargets")) as { targetInfos?: TargetInfo[] };
  const current = page.url();
  let picked = targets.targetInfos?.find((t) => t.type === "page" && t.attached && t.url === current);
  if (!picked) {
    picked = targets.targetInfos?.find((t) => t.type === "page" && t.attached);
  }
  if (!picked) {
    await session.detach().catch(() => undefined);
    throw new Error("Could not find a page target for this window (CDP).");
  }

  const { windowId } = (await session.send("Browser.getWindowForTarget", {
    targetId: picked.targetId,
  })) as { windowId: number };

  try {
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        windowState: "normal",
        left: -10_000,
        top: -10_000,
        width: 1280,
        height: 900,
      },
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Move browser window onto the primary display (for /show after CDP off-screen or spawn). */
async function restoreBrowserWindowOnScreen(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);

  const targets = (await session.send("Target.getTargets")) as { targetInfos?: TargetInfo[] };
  const current = page.url();
  let picked = targets.targetInfos?.find((t) => t.type === "page" && t.attached && t.url === current);
  if (!picked) {
    picked = targets.targetInfos?.find((t) => t.type === "page" && t.attached);
  }
  if (!picked) {
    await session.detach().catch(() => undefined);
    throw new Error("Could not find a page target for this window (CDP).");
  }

  const { windowId } = (await session.send("Browser.getWindowForTarget", {
    targetId: picked.targetId,
  })) as { windowId: number };

  try {
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        windowState: "normal",
        left: 80,
        top: 80,
        width: 1280,
        height: 900,
      },
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export type HideBrowserResult = { usedWin32: boolean; usedCdpOffScreen: boolean };

/**
 * Hide the headed browser without using headless mode.
 * Windows: user32 ShowWindow(HIDE) + SetWindowPos(HIDEWINDOW) on the root HWND, across the browser PID tree.
 * Fallback: CDP moves the window off-screen only (no minimize).
 */
export async function hideBrowserWindow(page: Page, profileDir?: string): Promise<HideBrowserResult> {
  const dbg = windowDebugEnabled();

  if (isWin32()) {
    if (dbg) console.error("[mira/hide] trying Win32 (user32) hide first…");
    try {
      if (await hideBrowserWindowWin32(page, profileDir)) {
        if (dbg) console.error("[mira/hide] Win32 hide reported success.");
        return { usedWin32: true, usedCdpOffScreen: false };
      }
    } catch (e) {
      if (dbg) console.error("[mira/hide] Win32 path threw:", e);
    }
    if (dbg) {
      console.error("[mira/hide] Win32 failed; dumping HWNDs, then CDP off-screen fallback…");
      diagnoseBrowserWindows(page, profileDir);
    }
  } else if (dbg) {
    console.error("[mira/hide] not Windows — CDP off-screen only.");
  }

  await hideBrowserWindowCdpOffScreen(page);
  if (dbg) console.error("[mira/hide] CDP off-screen bounds applied.");
  return { usedWin32: false, usedCdpOffScreen: true };
}

/** Restore visibility and move the window into view (Win32 show + CDP bounds onto the desktop). */
export async function showBrowserWindow(page: Page, profileDir?: string): Promise<boolean> {
  let cdpOk = false;
  try {
    await restoreBrowserWindowOnScreen(page);
    cdpOk = true;
  } catch (e) {
    if (windowDebugEnabled()) {
      console.error("[mira/show] CDP on-screen bounds:", e instanceof Error ? e.message : String(e));
    }
  }
  if (isWin32() && (await showBrowserWindowWin32(page, profileDir))) return true;
  return cdpOk;
}

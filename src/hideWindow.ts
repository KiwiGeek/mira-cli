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

/** Restore window after Win32 hide. CDP off-screen fallback is not fully reversible here. */
export async function showBrowserWindow(page: Page, profileDir?: string): Promise<boolean> {
  if (isWin32() && (await showBrowserWindowWin32(page, profileDir))) return true;
  return false;
}

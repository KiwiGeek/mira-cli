/** Parse milliseconds from env; invalid/missing uses fallback (minimum 1000 ms). */

export function miraEnvMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? n : fallback;
}

/** Composer mount wait after navigation / new chat. */
export function composerReadyMs(): number {
  return miraEnvMs("MIRA_COMPOSER_READY_MS", 180_000);
}

/** Single-strategy attach poll inside `waitForComposerMount` (per locator try). */
export function composerAttachPollMs(): number {
  return miraEnvMs("MIRA_COMPOSER_ATTACH_POLL_MS", 8_000);
}

/** Max wall-clock wait for assistant reply after send (streaming DOM polls). */
export function responseTimeoutMs(): number {
  return miraEnvMs("MIRA_RESPONSE_TIMEOUT_MS", 480_000);
}

/**
 * After Stop hides: poll until `<img>` nodes in the latest assistant turn finish loading (or timeout).
 */
export function assistantImageReadyMs(): number {
  return miraEnvMs("MIRA_ASSISTANT_IMAGE_READY_MS", 120_000);
}

/** Extra window at end of finalizeAssistantReply while assistant text may still drift. */
export function replyTailSettleMs(): number {
  return miraEnvMs("MIRA_REPLY_TAIL_SETTLE_MS", 45_000);
}

/** Pause before scraping images after reply (DOM settle). */
export function capturePauseMs(): number {
  return miraEnvMs("MIRA_CAPTURE_PAUSE_MS", 1_500);
}

/** Timeout for downloading image bytes via HTTP(S) using Playwright request (cookies attached). */
export function imageFetchTimeoutMs(): number {
  return miraEnvMs("MIRA_IMAGE_FETCH_TIMEOUT_MS", 120_000);
}

/** Timeout per `<img>` element screenshot fallback. */
export function imageScreenshotTimeoutMs(): number {
  return miraEnvMs("MIRA_IMAGE_SCREENSHOT_TIMEOUT_MS", 180_000);
}

/** Scroll-into-view timeout before screenshot/fetch per image. */
export function imageScrollTimeoutMs(): number {
  return miraEnvMs("MIRA_IMAGE_SCROLL_TIMEOUT_MS", 45_000);
}

/** Wait before returning final assistant text — catches `<img>` inserted after caption stabilizes. */
export function finalizeImageReadyMs(): number {
  return miraEnvMs("MIRA_FINALIZE_IMAGE_READY_MS", 45_000);
}

/** How long to wait for Stop / Stop generating to appear before assuming a fast reply. */
export function stopButtonAppearTimeoutMs(): number {
  return miraEnvMs("MIRA_STOP_BUTTON_APPEAR_MS", 45_000);
}

/** Wait for composer thread to expose at least one assistant turn again after UI churn (ms). */
export function assistantDomResyncMs(): number {
  return miraEnvMs("MIRA_ASSISTANT_DOM_RESYNC_MS", 25_000);
}

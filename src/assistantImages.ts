import type { Page } from "playwright";
import { PNG } from "pngjs";
import { assistantBubbleShowsImagePlaceholder } from "./assistantPlaceholder.js";
import { assistantMessageLocator, scrollConversationIntoView } from "./selectors.js";
import { replDebug, replDebugEnabled } from "./replDebug.js";
import {
  assistantImageReadyMs,
  capturePauseMs,
  imageFetchTimeoutMs,
  imageScreenshotTimeoutMs,
  imageScrollTimeoutMs,
} from "./replTimeouts.js";

const MIN_NATURAL_W = 72;
const MIN_NATURAL_H = 72;
const DEFAULT_MAX_IMAGES = 8;

function maxImagesCap(): number {
  const raw = process.env.MIRA_MAX_ASSISTANT_IMAGES;
  if (!raw) return DEFAULT_MAX_IMAGES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 24) : DEFAULT_MAX_IMAGES;
}

/** Weak fingerprint to skip duplicate screenshots of the same asset. */
function bufferSig(buf: Buffer): string {
  const head = buf.subarray(0, Math.min(48, buf.length));
  return `${buf.length}:${head.toString("base64")}`;
}

function looksLikePng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/** pngjs validates structure; sixel pipeline expects decodable PNG. */
function isDecodablePng(buf: Buffer): boolean {
  if (!looksLikePng(buf) || buf.length < 900) return false;
  try {
    PNG.sync.read(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull bytes via URL when Playwright can reuse the browser session (cookie-backed CDN URLs).
 * JPEG/WebP payloads return null — screenshot fallback produces PNG for pngjs + sixels.
 */
async function fetchImageBytesFromSrc(page: Page, src: string): Promise<Buffer | null> {
  const trimmed = src.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("data:image/")) {
      const m = /^data:image\/[^;]+;base64,([\s\S]+)$/i.exec(trimmed);
      if (!m?.[1]) return null;
      const buf = Buffer.from(m[1].replace(/\s/g, ""), "base64");
      return isDecodablePng(buf) ? buf : null;
    }

    if (trimmed.startsWith("blob:")) {
      const bytes = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url);
          if (!r.ok) return null;
          const ab = await r.arrayBuffer();
          return Array.from(new Uint8Array(ab));
        } catch {
          return null;
        }
      }, trimmed);
      if (!bytes?.length) return null;
      const buf = Buffer.from(bytes);
      return isDecodablePng(buf) ? buf : null;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const resp = await page.request.get(trimmed, { timeout: imageFetchTimeoutMs() });
      if (!resp.ok()) {
        replDebug("fetchImageBytesFromSrc: HTTP", resp.status(), trimmed.slice(0, 120));
        return null;
      }
      const body = await resp.body();
      return isDecodablePng(body) ? body : null;
    }
  } catch (e) {
    replDebug("fetchImageBytesFromSrc failed:", trimmed.slice(0, 140), e instanceof Error ? e.message : e);
    return null;
  }

  return null;
}

/**
 * Wait until substantive `<img>` / `<canvas>` pixels look decoded and typical inline-loading UI settles.
 * `complete` alone is unreliable—layout can be large while `naturalWidth` is still 0 during decode.
 */
export async function waitForAssistantTurnImagesReady(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs < 250) return;

  await scrollConversationIntoView(page);
  const loc = assistantMessageLocator(page);
  const nTurns = await loc.count();
  if (nTurns === 0) {
    replDebug("waitForAssistantTurnImagesReady: skip (no assistant row)");
    return;
  }

  const root = loc.last();
  const deadline = Date.now() + timeoutMs;
  let lap = 0;

  while (Date.now() < deadline) {
    lap++;
    const snap = await root
      .evaluate(
        async (el: HTMLElement) => {
          const MIN = 72;
          let pendingIncomplete = 0;
          let pendingIntrinsic = 0;
          let canvasPending = 0;

          for (const img of el.querySelectorAll("img")) {
            const im = img as HTMLImageElement;
            const src = (im.currentSrc || im.src || "").trim();
            if (!src || /twemoji|emoji\.svg/i.test(src)) continue;

            const r = im.getBoundingClientRect();
            const layoutLarge = r.width >= 48 || r.height >= 48;

            if (!im.complete) {
              pendingIncomplete++;
              continue;
            }

            let nw = im.naturalWidth || 0;
            let nh = im.naturalHeight || 0;

            if (layoutLarge && (nw < MIN || nh < MIN) && /^https?:|blob:|data:/i.test(src)) {
              try {
                await im.decode();
              } catch {
                /* CORS / decode failures — fall through */
              }
              nw = im.naturalWidth || 0;
              nh = im.naturalHeight || 0;
              if (nw < MIN || nh < MIN) pendingIntrinsic++;
            }
          }

          for (const cv of el.querySelectorAll("canvas")) {
            const r = cv.getBoundingClientRect();
            if (r.width < 48 && r.height < 48) continue;
            if (cv.width < MIN || cv.height < MIN) canvasPending++;
          }

          return {
            pendingIncomplete,
            pendingIntrinsic,
            canvasPending,
            bubbleTextSample: el.innerText.trim().slice(0, 2500),
          };
        },
        undefined,
        { timeout: 25_000 },
      )
      .catch(() => ({
        pendingIncomplete: 0,
        pendingIntrinsic: 0,
        canvasPending: 0,
        bubbleTextSample: "",
      }));

    const pendingPlaceholder = assistantBubbleShowsImagePlaceholder(snap.bubbleTextSample) ? 1 : 0;
    const pendingTotal =
      snap.pendingIncomplete +
      snap.pendingIntrinsic +
      snap.canvasPending +
      pendingPlaceholder;

    if (pendingTotal === 0) {
      replDebug(`waitForAssistantTurnImagesReady: idle (${lap} poll(s))`);
      return;
    }

    if (replDebugEnabled() && lap === 1) {
      replDebug(`waitForAssistantTurnImagesReady: pending`, {
        ...snap,
        pendingPlaceholder,
        bubblePreview: snap.bubbleTextSample.slice(0, 140),
        budgetMs: timeoutMs,
      });
    }

    await scrollConversationIntoView(page);
    await page.waitForTimeout(280).catch(() => undefined);
  }

  replDebug("waitForAssistantTurnImagesReady: timed out with pending visual loads");
}

/**
 * PNG buffers for substantive `<img>` nodes inside the latest assistant turn.
 * Prefers HTTP/blob/data fetch when the payload is PNG (fast); falls back to element screenshots.
 */
export async function captureLastAssistantImages(page: Page): Promise<Buffer[]> {
  await scrollConversationIntoView(page);
  const loc = assistantMessageLocator(page);
  const nTurns = await loc.count();
  if (nTurns === 0) {
    replDebug("captureLastAssistantImages: no assistant row");
    return [];
  }

  const root = loc.last();
  await root.scrollIntoViewIfNeeded({ timeout: imageScrollTimeoutMs() }).catch(() => undefined);

  await page.waitForTimeout(capturePauseMs()).catch(() => undefined);

  const teaser = await root.innerText().catch(() => "");
  if (assistantBubbleShowsImagePlaceholder(teaser)) {
    replDebug("captureLastAssistantImages: placeholder copy still visible — extra ready wait");
    await waitForAssistantTurnImagesReady(page, Math.min(assistantImageReadyMs(), 180_000));
  }

  const imgs = root.locator("img");
  const n = await imgs.count();
  replDebug(`captureLastAssistantImages: img count=${n}`);
  const maxOut = maxImagesCap();
  const seen = new Set<string>();
  const out: Buffer[] = [];

  for (let i = 0; i < n && out.length < maxOut; i++) {
    const im = imgs.nth(i);

    try {
      await im.scrollIntoViewIfNeeded({ timeout: imageScrollTimeoutMs() }).catch(() => undefined);

      const loadWaitCap = Math.min(120_000, imageScreenshotTimeoutMs());
      await im
        .evaluate(
          async (el: HTMLImageElement, ms: number) => {
            await new Promise<void>((resolve) => {
              if (el.complete) resolve();
              else {
                el.addEventListener("load", () => resolve(), { once: true });
                el.addEventListener("error", () => resolve(), { once: true });
                setTimeout(() => resolve(), ms);
              }
            });
            try {
              await el.decode();
            } catch {
              /* decode may reject before pixels exist */
            }
          },
          loadWaitCap,
        )
        .catch(() => undefined);

      let src = (await im.getAttribute("src").catch(() => "")) ?? "";

      const dims = await im
        .evaluate((el: HTMLImageElement) => {
          const r = el.getBoundingClientRect();
          return {
            nw: el.naturalWidth || 0,
            nh: el.naturalHeight || 0,
            bw: Math.round(r.width),
            bh: Math.round(r.height),
          };
        })
        .catch(() => ({ nw: 0, nh: 0, bw: 0, bh: 0 }));

      if (/twemoji|emoji\.svg/i.test(src) && dims.bw < 160 && dims.bh < 160) continue;

      const substantive =
        (dims.nw >= MIN_NATURAL_W && dims.nh >= MIN_NATURAL_H) ||
        (dims.bw >= MIN_NATURAL_W && dims.bh >= MIN_NATURAL_H);
      if (!substantive) continue;

      let shot: Buffer | null = null;

      const fetched = src ? await fetchImageBytesFromSrc(page, src) : null;
      if (fetched) {
        replDebug(
          `capture img[${i}]: fetched PNG via URL (${fetched.length}b) nw=${dims.nw}x${dims.nh} box=${dims.bw}x${dims.bh} ${src.slice(0, 96)}`,
        );
        shot = fetched;
      } else {
        replDebug(
          `capture img[${i}]: screenshot nw=${dims.nw}x${dims.nh} box=${dims.bw}x${dims.bh} src=${src.slice(0, 96)}`,
        );
        shot = await im.screenshot({ type: "png", timeout: imageScreenshotTimeoutMs() }).catch(() => null);
      }

      if (!shot || shot.length < 900) continue;

      const sig = bufferSig(shot);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(shot);
    } catch (e) {
      replDebug(`capture img[${i}] error:`, e instanceof Error ? e.message : e);
    }
  }

  const canvases = root.locator("canvas");
  const nc = await canvases.count();
  replDebug(`captureLastAssistantImages: canvas count=${nc}`);
  for (let i = 0; i < nc && out.length < maxOut; i++) {
    const cv = canvases.nth(i);
    try {
      const dims = await cv
        .evaluate((el: HTMLCanvasElement) => {
          const r = el.getBoundingClientRect();
          return {
            pw: el.width,
            ph: el.height,
            bw: Math.round(r.width),
            bh: Math.round(r.height),
          };
        })
        .catch(() => ({ pw: 0, ph: 0, bw: 0, bh: 0 }));

      const ww = Math.max(dims.pw, dims.bw);
      const hh = Math.max(dims.ph, dims.bh);
      if (ww < MIN_NATURAL_W || hh < MIN_NATURAL_H) continue;

      await cv.scrollIntoViewIfNeeded({ timeout: imageScrollTimeoutMs() }).catch(() => undefined);
      replDebug(`capture canvas[${i}]: screenshot ${ww}x${hh} (bitmap ${dims.pw}x${dims.ph})`);
      const shot = await cv.screenshot({ type: "png", timeout: imageScreenshotTimeoutMs() }).catch(() => null);
      if (!shot || shot.length < 900) continue;

      const sig = bufferSig(shot);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(shot);
    } catch (e) {
      replDebug(`capture canvas[${i}] error:`, e instanceof Error ? e.message : e);
    }
  }

  if (out.length === 0 && replDebugEnabled()) {
    const diag = await root
      .evaluate(
        (el: HTMLElement) => ({
          imgs: [...el.querySelectorAll("img")].map((node) => {
            const im = node as HTMLImageElement;
            const src = im.currentSrc || im.src || "";
            const r = im.getBoundingClientRect();
            return {
              nw: im.naturalWidth || im.width || 0,
              nh: im.naturalHeight || im.height || 0,
              bw: Math.round(r.width),
              bh: Math.round(r.height),
              complete: im.complete,
              srcLen: src.length,
              srcPrefix: src.slice(0, 140),
            };
          }),
          canvases: [...el.querySelectorAll("canvas")].map((cv) => {
            const r = cv.getBoundingClientRect();
            return {
              pw: cv.width,
              ph: cv.height,
              bw: Math.round(r.width),
              bh: Math.round(r.height),
            };
          }),
        }),
        undefined,
        { timeout: 8_000 },
      )
      .catch(() => ({
        imgs: [] as {
          nw: number;
          nh: number;
          bw: number;
          bh: number;
          complete: boolean;
          srcLen: number;
          srcPrefix: string;
        }[],
        canvases: [] as { pw: number; ph: number; bw: number; bh: number }[],
      }));
    replDebug("captureLastAssistantImages: zero PNG outputs; probe:", diag);
  }

  replDebug(`captureLastAssistantImages: captured ${out.length} PNG buffer(s)`);
  return out;
}

/**
 * Encode RGBA pixels into a DEC sixel DCS sequence (ESC P … ESC \\).
 * Palette colors use DEC form "#n;2;r;g;b" with r,g,b as percentages 0–100.
 */

import { PNG } from "pngjs";

export const SIXEL_FINALIZER = "\x1b\\";

/** DCS introducer; middle parameter is DEC background-select (0 default). */
export function sixelIntroducer(backgroundSelect: 0 | 1 | 2 = 0): string {
  return `\x1bP0;${backgroundSelect};q`;
}

export type EncodeSixelOptions = {
  /** Max opaque palette entries (excluding transparent slot). Default 96. */
  maxColors?: number;
  /** Scale down so width ≤ this (preserving aspect). Default 720. */
  maxWidth?: number;
  /** Scale down so height ≤ this. Default 480. */
  maxHeight?: number;
  /** Pixels with alpha below this become transparent (palette index 0). Default 128. */
  alphaCutoff?: number;
  backgroundSelect?: 0 | 1 | 2;
};

type RGB = { r: number; g: number; b: number };

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

function rgbToPct(v: number): number {
  return Math.round((clampByte(v) / 255) * 100);
}

function scaleNearest(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      data[di] = src[si]!;
      data[di + 1] = src[si + 1]!;
      data[di + 2] = src[si + 2]!;
      data[di + 3] = src[si + 3]!;
    }
  }
  return { data, width: dw, height: dh };
}

function collectOpaquePixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  alphaCutoff: number,
  maxSamples: number,
): RGB[] {
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxSamples)));
  const out: RGB[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3]!;
      if (a < alphaCutoff) continue;
      out.push({ r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! });
    }
  }
  return out;
}

function averageRgb(points: RGB[]): RGB {
  let r = 0,
    g = 0,
    b = 0;
  for (const p of points) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = points.length || 1;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function splitBox(points: RGB[]): [RGB[], RGB[]] {
  if (points.length < 2) {
    return [points, []];
  }
  let rMin = 255,
    rMax = 0,
    gMin = 255,
    gMax = 0,
    bMin = 255,
    bMax = 0;
  for (const p of points) {
    rMin = Math.min(rMin, p.r);
    rMax = Math.max(rMax, p.r);
    gMin = Math.min(gMin, p.g);
    gMax = Math.max(gMax, p.g);
    bMin = Math.min(bMin, p.b);
    bMax = Math.max(bMax, p.b);
  }
  const rRange = rMax - rMin;
  const gRange = gMax - gMin;
  const bRange = bMax - bMin;
  type Axis = keyof RGB;
  let axis: Axis = "r";
  let range = rRange;
  if (gRange > range) {
    axis = "g";
    range = gRange;
  }
  if (bRange > range) {
    axis = "b";
    range = bRange;
  }
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(sorted.length / 2);
  if (mid < 1) {
    return [sorted, []];
  }
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

/** Median-cut boxes → opaque palette entries (length ≤ maxOpaque). */
function medianCutPalette(opaqueSamples: RGB[], maxOpaque: number): RGB[] {
  if (opaqueSamples.length === 0) return [];
  let boxes: RGB[][] = [opaqueSamples];
  while (boxes.length < maxOpaque) {
    let bestIdx = -1;
    let bestLen = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.length > bestLen) {
        bestLen = boxes[i]!.length;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestLen < 2) break;
    const [a, b] = splitBox(boxes[bestIdx]!);
    if (a.length === 0 || b.length === 0) break;
    boxes.splice(bestIdx, 1, a, b);
  }
  return boxes.map(averageRgb);
}

function nearestPaletteIndex(r: number, g: number, b: number, palette: RGB[]): number {
  if (palette.length === 0) return 1;
  let best = 1;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
}

/** Palette index per pixel; 0 = transparent, 1..K map to palette[0..K-1]. */
function mapToIndices(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: RGB[],
  alphaCutoff: number,
): Uint16Array {
  const pix = width * height;
  const indices = new Uint16Array(pix);
  for (let i = 0; i < pix; i++) {
    const o = i * 4;
    const a = rgba[o + 3]!;
    if (a < alphaCutoff) {
      indices[i] = 0;
      continue;
    }
    indices[i] = nearestPaletteIndex(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, palette);
  }
  return indices;
}

function codeToSixelChar(pattern: number, repeat: number): string {
  const c = String.fromCharCode(pattern + 63);
  if (repeat > 3) return `!${repeat}${c}`;
  return c.repeat(repeat);
}

/**
 * Encode one horizontal band (≤ 6 pixel rows) using indexed colors.
 * Transparent pixels (index 0) leave all patterns unset for those samples.
 */
function encodeBandIndexed(
  indices: Uint16Array,
  bandTopPx: number,
  bandHeight: number,
  width: number,
  height: number,
  /** Highest opaque palette slot index (= palette.length). */
  maxPalSlot: number,
): string {
  const last = new Int8Array(maxPalSlot + 2);
  const code = new Uint8Array(maxPalSlot + 2);
  const accu = new Uint16Array(maxPalSlot + 2);
  const slots = new Int16Array(maxPalSlot + 2);
  last.fill(-1);
  accu.fill(1);
  slots.fill(-1);

  const usedPalSlot: number[] = [];
  const targets: string[][] = [];

  const startOffset = bandTopPx * width;

  for (let col = 0; col < width; col++) {
    const p = startOffset + col;
    let rowOffset = 0;
    code.fill(0, 0, usedPalSlot.length);

    for (let row = 0; row < bandHeight; row++) {
      const y = bandTopPx + row;
      if (y >= height) break;
      const palSlot = indices[p + rowOffset]!;
      if (palSlot === 0) {
        rowOffset += width;
        continue;
      }

      let j = slots[palSlot];
      if (j === -1) {
        targets.push([]);
        if (col > 0) {
          last[usedPalSlot.length] = 0;
          accu[usedPalSlot.length] = col;
        }
        j = usedPalSlot.length;
        slots[palSlot] = j;
        usedPalSlot.push(palSlot);
      }
      code[j]! |= 1 << row;
      rowOffset += width;
    }

    for (let j = 0; j < usedPalSlot.length; j++) {
      if (code[j]! === last[j]) {
        accu[j]!++;
      } else {
        if (~last[j]!) {
          targets[j]!.push(codeToSixelChar(last[j]!, accu[j]!));
        }
        last[j] = code[j]!;
        accu[j] = 1;
      }
    }
  }

  for (let j = 0; j < usedPalSlot.length; j++) {
    if (last[j]!) {
      targets[j]!.push(codeToSixelChar(last[j]!, accu[j]!));
    }
  }

  const parts: string[] = [];
  for (let j = 0; j < usedPalSlot.length; j++) {
    const palSlot = usedPalSlot[j]!;
    if (!palSlot) continue;
    parts.push(`#${palSlot - 1}${targets[j]!.join("")}$`);
  }
  return parts.join("");
}

/** Raster attributes + palette definitions + bands (joined with "-" newline between bands). */
function encodeIndexedToSixelBody(
  indices: Uint16Array,
  width: number,
  height: number,
  palette: RGB[],
): string {
  const chunks: string[] = [];
  chunks.push(`"1;1;${width};${height}`);
  for (let i = 0; i < palette.length; i++) {
    const { r, g, b } = palette[i]!;
    chunks.push(`#${i};2;${rgbToPct(r)};${rgbToPct(g)};${rgbToPct(b)}`);
  }

  const maxPalSlot = palette.length;
  const bands: string[] = [];
  for (let bandTop = 0; bandTop < height; bandTop += 6) {
    const bandH = Math.min(6, height - bandTop);
    bands.push(encodeBandIndexed(indices, bandTop, bandH, width, height, maxPalSlot));
  }
  chunks.push(bands.join("-\n"));
  return chunks.join("");
}

/**
 * Encode RGBA8888 row-major image into a complete sixel string (introducer + body + finalizer).
 */
export function rgbaToSixelSequence(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: EncodeSixelOptions = {},
): string {
  const maxColors = opts.maxColors ?? 96;
  const maxW = opts.maxWidth ?? 720;
  const maxH = opts.maxHeight ?? 480;
  const alphaCutoff = opts.alphaCutoff ?? 128;
  const bgSel = opts.backgroundSelect ?? 0;

  if (!width || !height || rgba.length !== width * height * 4) {
    throw new Error("rgbaToSixelSequence: invalid dimensions or buffer length");
  }

  let data = rgba;
  let w = width;
  let h = height;
  const scaleW = w > maxW ? maxW / w : 1;
  const scaleH = h > maxH ? maxH / h : 1;
  const scale = Math.min(scaleW, scaleH, 1);
  if (scale < 1) {
    const dw = Math.max(1, Math.floor(w * scale));
    const dh = Math.max(1, Math.floor(h * scale));
    const scaled = scaleNearest(rgba, w, h, dw, dh);
    data = scaled.data;
    w = scaled.width;
    h = scaled.height;
  }

  const opaqueSamples = collectOpaquePixels(data, w, h, alphaCutoff, 48_000);
  let opaquePalette = medianCutPalette(opaqueSamples, Math.max(1, Math.min(maxColors, 256)));
  if (opaquePalette.length === 0) {
    opaquePalette = [{ r: 128, g: 128, b: 128 }];
  }
  const palette: RGB[] = opaquePalette;

  const indices = mapToIndices(data, w, h, palette, alphaCutoff);
  const body = encodeIndexedToSixelBody(indices, w, h, palette);
  return `${sixelIntroducer(bgSel)}${body}${SIXEL_FINALIZER}`;
}

/** Decode PNG bytes and return a full sixel sequence. */
export function pngBufferToSixelSequence(pngBytes: Buffer, opts?: EncodeSixelOptions): string {
  const png = PNG.sync.read(pngBytes);
  const rgba = new Uint8ClampedArray(png.data);
  return rgbaToSixelSequence(rgba, png.width, png.height, opts);
}

/** Encode options scaled from measured terminal width (character cells). */
export function terminalFitSixelOptions(termCols: number): EncodeSixelOptions {
  const cols = typeof termCols === "number" && termCols > 0 ? termCols : 80;
  const maxWidth = Math.min(960, Math.max(280, cols * 14));
  return { maxWidth, maxHeight: 480, maxColors: 88, backgroundSelect: 0 };
}

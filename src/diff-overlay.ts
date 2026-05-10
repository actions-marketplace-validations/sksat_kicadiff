/**
 * Tri-colour visual diff: classifies each pixel of two same-sized PNG buffers
 * as added (green), deleted (red), or moved/changed (yellow). Two output
 * shapes:
 *   - triColorDiff() — single combined RGBA mask with all three categories.
 *     Used by tests and as the implementation core; legacy single-overlay
 *     callers still work against it.
 *   - splitDiff()    — pair of RGBA masks; deletes go on the "before" mask
 *     (where the removed content actually existed in the prior render), adds
 *     and changes go on the "after" mask (where the new state is visible).
 *     This is what the viewer attaches per-side so a vanished trace shows up
 *     under the BEFORE image, not over an empty spot in the AFTER image.
 *
 * The classification is intentionally simple — kicadiff is not a vector
 * diffing tool, so we work on rasterised output. Two regimes:
 *
 *   1. Transparent-background renders (schematics, per-layer PCB output,
 *      symbol library entries). "Empty" = alpha below a threshold. Direct
 *      add/delete from alpha changes; change when both opaque but the colour
 *      moved beyond a perceptual threshold.
 *
 *   2. Solid-background renders (PCB combined SVG → PNG, which keeps the
 *      KiCad board background). We sample each side's background colour from
 *      the top-left corner and treat any pixel close to that colour as empty.
 *      The kicad-cli render is deterministic so the corner is reliably blank.
 *
 * Output channel meaning:
 *   - alpha=0     → no change
 *   - red 255     → delete (was content, now empty)
 *   - green 255   → add (was empty, now content)
 *   - yellow      → moved / changed (both sides have content but pixels differ)
 */

import { PNG } from "pngjs";

/** Pre-defined colours so callers (and tests) reference the same RGB. */
export const DIFF_COLORS = {
  add: [0, 220, 0] as const,       // bright green
  remove: [255, 0, 0] as const,    // bright red
  change: [255, 200, 0] as const,  // amber (so it reads as "different from add/delete")
};

interface DiffOptions {
  /** Maximum per-channel distance for two pixels to count as "the same".
   *  Equivalent to the previous magick `-fuzz 5%` (≈13/255). We use 25 to
   *  also tolerate sub-pixel anti-aliasing differences. */
  colorTolerance?: number;
  /** Pixels whose alpha is below this are considered empty / background.
   *  For transparent-background renders only; ignored when both inputs have
   *  a solid background. */
  alphaCutoff?: number;
}

/** Read one pixel as [r,g,b,a] from a pngjs buffer at (x, y). */
function pixelAt(img: PNG, x: number, y: number): [number, number, number, number] {
  const i = (img.width * y + x) << 2;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Per-channel max difference. Cheaper than Euclidean distance and matches
 *  how ImageMagick computes -fuzz tolerances. */
function pixelDistance(a: [number, number, number, number], b: [number, number, number, number]): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

/** Pixel "is empty" when:
 *   - its alpha is below the cutoff (transparent), OR
 *   - the inputs are in solid-background mode AND it's close to the sampled
 *     background colour.
 *  Keeping both rules in one function means the caller doesn't have to know
 *  which rendering regime it has. */
function isEmpty(
  px: [number, number, number, number],
  bg: [number, number, number, number] | null,
  alphaCutoff: number,
  bgTolerance: number,
): boolean {
  if (px[3] < alphaCutoff) return true;
  if (bg === null) return false;
  return pixelDistance(px, bg) <= bgTolerance;
}

type Category = "add" | "remove" | "change" | null;

/** Shared classifier core. Decodes both PNGs, sets up the background regime,
 *  and walks every pixel handing the category off to a per-pixel writer. The
 *  two public entry points (triColorDiff, splitDiff) only differ in how many
 *  output buffers they fill and which categories land in each one. */
function classifyPixels(
  before: Buffer,
  after: Buffer,
  opts: DiffOptions,
  callerName: string,
  visit: (i: number, category: Category) => void,
): { width: number; height: number } {
  const colorTolerance = opts.colorTolerance ?? 25;
  const alphaCutoff = opts.alphaCutoff ?? 16;

  const b = PNG.sync.read(before);
  const a = PNG.sync.read(after);
  if (b.width !== a.width || b.height !== a.height) {
    throw new Error(
      `${callerName}: dimension mismatch (before ${b.width}x${b.height}, after ${a.width}x${a.height})`,
    );
  }
  const w = b.width;
  const h = b.height;

  // Background detection. KiCad renders place the page on a canvas with
  // padding around the board / sheet, so the top-left corner is reliably
  // blank in real output. We engage solid-background mode only when:
  //   1. Both sides have a non-transparent corner (alpha > 0), AND
  //   2. The corners agree to within the colour tolerance.
  // If either fails we fall back to alpha-only classification, which is
  // both safer for unusual inputs and exactly what schematics need
  // (kicad-cli sch export uses --no-background-color).
  const bgTolerance = colorTolerance + 10;
  const bgBeforeRaw = pixelAt(b, 0, 0);
  const bgAfterRaw = pixelAt(a, 0, 0);
  const useSolidBg =
    bgBeforeRaw[3] > 0 &&
    bgAfterRaw[3] > 0 &&
    pixelDistance(bgBeforeRaw, bgAfterRaw) <= bgTolerance;
  const bgBefore = useSolidBg ? bgBeforeRaw : null;
  const bgAfter = useSolidBg ? bgAfterRaw : null;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      const bp = pixelAt(b, x, y);
      const ap = pixelAt(a, x, y);
      const beforeEmpty = isEmpty(bp, bgBefore, alphaCutoff, bgTolerance);
      const afterEmpty = isEmpty(ap, bgAfter, alphaCutoff, bgTolerance);

      let category: Category = null;
      if (beforeEmpty && !afterEmpty) category = "add";
      else if (!beforeEmpty && afterEmpty) category = "remove";
      else if (!beforeEmpty && !afterEmpty && pixelDistance(bp, ap) > colorTolerance) {
        category = "change";
      }
      visit(i, category);
    }
  }
  return { width: w, height: h };
}

/** Write a single classified colour into an RGBA buffer at offset `i`. */
function paint(buf: Buffer, i: number, color: readonly [number, number, number]): void {
  buf[i]     = color[0];
  buf[i + 1] = color[1];
  buf[i + 2] = color[2];
  buf[i + 3] = 255;
}

/** Classify each pixel of `before` and `after` and return one combined RGBA
 *  mask with all three categories. Kept for backwards compatibility and
 *  because the unit tests find a single-image output simpler to reason
 *  about. The viewer uses splitDiff() instead so deletes can sit on top of
 *  the before-side image. */
export function triColorDiff(
  before: Buffer,
  after: Buffer,
  opts: DiffOptions = {},
): Buffer {
  // We need width/height up-front to allocate the PNG, so peek at the
  // before image's header. classifyPixels decodes again internally; for the
  // test-sized inputs we run on, the cost is negligible.
  const head = PNG.sync.read(before);
  const out = new PNG({ width: head.width, height: head.height });
  classifyPixels(before, after, opts, "triColorDiff", (i, cat) => {
    if (cat === "add") paint(out.data, i, DIFF_COLORS.add);
    else if (cat === "remove") paint(out.data, i, DIFF_COLORS.remove);
    else if (cat === "change") paint(out.data, i, DIFF_COLORS.change);
    else out.data[i + 3] = 0;
  });
  return PNG.sync.write(out);
}

/** Classify pixels and return *two* RGBA masks: deletes on the before-side
 *  mask, adds + changes on the after-side mask. The viewer attaches each
 *  mask to its matching image so the highlight always sits on top of the
 *  side that actually shows the affected content. */
export function splitDiff(
  before: Buffer,
  after: Buffer,
  opts: DiffOptions = {},
): { before: Buffer; after: Buffer } {
  // Same header peek as triColorDiff — splitDiff has to size two output
  // buffers ahead of the per-pixel walk. classifyPixels validates the after
  // side's dimensions match, so an inconsistent pair still throws cleanly.
  const head = PNG.sync.read(before);
  const beforeOut = new PNG({ width: head.width, height: head.height });
  const afterOut = new PNG({ width: head.width, height: head.height });
  classifyPixels(before, after, opts, "splitDiff", (i, cat) => {
    if (cat === "remove") {
      paint(beforeOut.data, i, DIFF_COLORS.remove);
      afterOut.data[i + 3] = 0;
    } else if (cat === "add") {
      paint(afterOut.data, i, DIFF_COLORS.add);
      beforeOut.data[i + 3] = 0;
    } else if (cat === "change") {
      paint(afterOut.data, i, DIFF_COLORS.change);
      beforeOut.data[i + 3] = 0;
    } else {
      beforeOut.data[i + 3] = 0;
      afterOut.data[i + 3] = 0;
    }
  });
  return {
    before: PNG.sync.write(beforeOut),
    after: PNG.sync.write(afterOut),
  };
}

/** Encode a synthetic PNG. Test helper. */
export function makeTestPng(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const [r, g, bv, a] = paint(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = bv;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

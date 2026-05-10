import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { triColorDiff, splitDiff, makeTestPng, DIFF_COLORS } from "../src/diff-overlay.ts";

// Pure-logic tests. No browser, no kicad-cli. Exercises the classifier on
// synthetic 4x4 PNGs so we can spell out the expected colour for every pixel.

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];
const RED_OPAQUE: [number, number, number, number] = [255, 0, 0, 255];
const BLUE_OPAQUE: [number, number, number, number] = [0, 0, 255, 255];
const GREEN_OPAQUE: [number, number, number, number] = [0, 255, 0, 255];

/** Read out the RGBA at (x, y) of a PNG buffer. */
function read(buf: Buffer, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(buf);
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

test("transparent → opaque pixel is classified as add (green)", () => {
  // Both 1x1 PNGs. Before is transparent, after has a solid red pixel.
  const before = makeTestPng(1, 1, () => TRANSPARENT);
  const after = makeTestPng(1, 1, () => RED_OPAQUE);
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([...DIFF_COLORS.add, 255]);
});

test("opaque → transparent pixel is classified as remove (red)", () => {
  const before = makeTestPng(1, 1, () => BLUE_OPAQUE);
  const after = makeTestPng(1, 1, () => TRANSPARENT);
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([...DIFF_COLORS.remove, 255]);
});

test("color change between two opaque pixels is classified as change (amber)", () => {
  const before = makeTestPng(1, 1, () => RED_OPAQUE);
  const after = makeTestPng(1, 1, () => BLUE_OPAQUE);
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([...DIFF_COLORS.change, 255]);
});

test("identical opaque pixels produce no overlay", () => {
  const before = makeTestPng(1, 1, () => RED_OPAQUE);
  const after = makeTestPng(1, 1, () => RED_OPAQUE);
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([0, 0, 0, 0]);
});

test("identical transparent pixels produce no overlay", () => {
  const before = makeTestPng(1, 1, () => TRANSPARENT);
  const after = makeTestPng(1, 1, () => TRANSPARENT);
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([0, 0, 0, 0]);
});

test("classifies all three categories simultaneously in one image", () => {
  // 3x1 strip:
  //   col 0: empty → red opaque   (add)
  //   col 1: red   → empty        (remove)
  //   col 2: red   → green        (change)
  const before = makeTestPng(3, 1, (x) => {
    if (x === 0) return TRANSPARENT;
    return RED_OPAQUE;
  });
  const after = makeTestPng(3, 1, (x) => {
    if (x === 0) return RED_OPAQUE;
    if (x === 1) return TRANSPARENT;
    return GREEN_OPAQUE;
  });
  const diff = triColorDiff(before, after);
  expect(read(diff, 0, 0)).toEqual([...DIFF_COLORS.add, 255]);
  expect(read(diff, 1, 0)).toEqual([...DIFF_COLORS.remove, 255]);
  expect(read(diff, 2, 0)).toEqual([...DIFF_COLORS.change, 255]);
});

test("solid-background mode treats corner-coloured pixels as empty", () => {
  // Mimics the PCB combined render (KiCad blue board background). Both sides
  // share the same background, so a pixel matching the corner means "no
  // content there" regardless of alpha=255.
  //
  // The 3x1 strip places content in the middle so the (0,0) corner —
  // which is what triColorDiff samples — is reliably background on both
  // sides. KiCad's actual renders pad the page around the board for
  // exactly this reason.
  const BG: [number, number, number, number] = [30, 50, 80, 255]; // dark blue
  const TRACK: [number, number, number, number] = [200, 30, 30, 255];
  const before = makeTestPng(3, 1, () => BG);
  const after = makeTestPng(3, 1, (x) => x === 1 ? TRACK : BG);
  const diff = triColorDiff(before, after);
  // (0,0): bg → bg → no change (also the corner used for bg sampling)
  expect(read(diff, 0, 0)).toEqual([0, 0, 0, 0]);
  // (1,0): bg → track → ADD
  expect(read(diff, 1, 0)).toEqual([...DIFF_COLORS.add, 255]);
  // (2,0): bg → bg → no change
  expect(read(diff, 2, 0)).toEqual([0, 0, 0, 0]);
});

test("dimension mismatch throws", () => {
  const before = makeTestPng(2, 2, () => RED_OPAQUE);
  const after = makeTestPng(3, 2, () => RED_OPAQUE);
  expect(() => triColorDiff(before, after)).toThrow(/dimension mismatch/);
});

// --- splitDiff: per-side overlays ---
//
// The viewer wants DELETE pixels overlaid on the BEFORE image (where the
// removed content actually existed) and ADD / CHANGE pixels on the AFTER
// image. splitDiff returns two RGBA masks so the viewer can attach them
// to the matching side without filtering colours in the browser.

test("splitDiff: delete pixel only appears on before-side overlay", () => {
  const before = makeTestPng(1, 1, () => BLUE_OPAQUE);
  const after = makeTestPng(1, 1, () => TRANSPARENT);
  const { before: beforeMask, after: afterMask } = splitDiff(before, after);
  expect(read(beforeMask, 0, 0)).toEqual([...DIFF_COLORS.remove, 255]);
  // Nothing on the after side — the deletion is shown where it used to be.
  expect(read(afterMask, 0, 0)).toEqual([0, 0, 0, 0]);
});

test("splitDiff: add pixel only appears on after-side overlay", () => {
  const before = makeTestPng(1, 1, () => TRANSPARENT);
  const after = makeTestPng(1, 1, () => RED_OPAQUE);
  const { before: beforeMask, after: afterMask } = splitDiff(before, after);
  expect(read(beforeMask, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(read(afterMask, 0, 0)).toEqual([...DIFF_COLORS.add, 255]);
});

test("splitDiff: change pixel only appears on after-side overlay", () => {
  const before = makeTestPng(1, 1, () => RED_OPAQUE);
  const after = makeTestPng(1, 1, () => BLUE_OPAQUE);
  const { before: beforeMask, after: afterMask } = splitDiff(before, after);
  // Change reads as "modification at this location"; the modified state is
  // what's visible on the after image, so that's where the highlight goes.
  expect(read(beforeMask, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(read(afterMask, 0, 0)).toEqual([...DIFF_COLORS.change, 255]);
});

test("splitDiff: identical pixels produce no overlay on either side", () => {
  const before = makeTestPng(1, 1, () => RED_OPAQUE);
  const after = makeTestPng(1, 1, () => RED_OPAQUE);
  const { before: beforeMask, after: afterMask } = splitDiff(before, after);
  expect(read(beforeMask, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(read(afterMask, 0, 0)).toEqual([0, 0, 0, 0]);
});

test("splitDiff: distributes all three categories across the two masks", () => {
  // Same setup as the triColorDiff combined test, but verifying that each
  // category lands on the correct side.
  //   col 0: empty → red    (add)    → after only
  //   col 1: red   → empty  (remove) → before only
  //   col 2: red   → green  (change) → after only
  const before = makeTestPng(3, 1, (x) => (x === 0 ? TRANSPARENT : RED_OPAQUE));
  const after = makeTestPng(3, 1, (x) => {
    if (x === 0) return RED_OPAQUE;
    if (x === 1) return TRANSPARENT;
    return GREEN_OPAQUE;
  });
  const { before: beforeMask, after: afterMask } = splitDiff(before, after);

  // Before overlay: only the deleted pixel at col 1.
  expect(read(beforeMask, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(read(beforeMask, 1, 0)).toEqual([...DIFF_COLORS.remove, 255]);
  expect(read(beforeMask, 2, 0)).toEqual([0, 0, 0, 0]);

  // After overlay: add at col 0, change at col 2, nothing at col 1.
  expect(read(afterMask, 0, 0)).toEqual([...DIFF_COLORS.add, 255]);
  expect(read(afterMask, 1, 0)).toEqual([0, 0, 0, 0]);
  expect(read(afterMask, 2, 0)).toEqual([...DIFF_COLORS.change, 255]);
});

test("splitDiff: dimension mismatch throws", () => {
  const before = makeTestPng(2, 2, () => RED_OPAQUE);
  const after = makeTestPng(3, 2, () => RED_OPAQUE);
  expect(() => splitDiff(before, after)).toThrow(/dimension mismatch/);
});

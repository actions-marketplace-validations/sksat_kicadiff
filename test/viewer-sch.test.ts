import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
// Use the schematic-only fixture so the viewer initializes in sch mode
const SCH_HTML = path.join(FIXTURE_DIR, "sch", "PicoBridge_diff.html");

test.skip(() => !fs.existsSync(SCH_HTML), "schematic fixture not found");

test.beforeEach(async ({ page }) => {
  await page.goto(`file://${SCH_HTML}`);
  // Overlay is the default view when before exists; sch fixture has before
  await page.waitForSelector("#view-ovl.active");
});

test.describe("Schematic viewer", () => {
  test("manifest type is sch", async ({ page }) => {
    const type = await page.evaluate(() => (window as any).MANIFEST.files[0].type);
    expect(type).toBe("sch");
  });

  test("layer list is hidden for schematic", async ({ page }) => {
    // Schematics don't have PCB layers — layer list should be hidden,
    // but the panel itself may be visible to host the diff toggle.
    const display = await page
      .locator("#layer-list")
      .evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("none");
  });

  test("combined schematic image is shown in side-by-side", async ({ page }) => {
    // No per-layer images: before has just the combined image, after may
    // additionally have a hidden diff overlay (data-diff="1").
    const beforeNonDiff = await page
      .locator("#sbs-before img:not([data-diff])")
      .count();
    const afterNonDiff = await page
      .locator("#sbs-after img:not([data-diff])")
      .count();
    expect(beforeNonDiff).toBe(1);
    expect(afterNonDiff).toBe(1);
  });

  test("schematic uses light background for layer-stack", async ({ page }) => {
    // Schematics are designed for white backgrounds (KiCad's default).
    // The layer-stack background should be light, not the dark #1e1e1e
    // used for PCB previews.
    const bg = await page
      .locator(".layer-stack")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // Expect a near-white color (sRGB > 230 on each channel)
    const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(match).not.toBeNull();
    const [r, g, b] = match!.slice(1).map(Number);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  test("diff highlight toggle is available for schematic", async ({ page }) => {
    // Diff highlight should work for schematics too — the toggle must be
    // visible somewhere even though the layer list is not.
    const hasDiff = await page.evaluate(() => !!(window as any).MANIFEST.files[0].diff);
    if (!hasDiff) test.skip();

    const diffCheckbox = page.locator('#layer-extras input[type="checkbox"]');
    await expect(diffCheckbox).toBeVisible();
  });

  test("toggling diff highlight shows/hides the overlay", async ({ page }) => {
    const hasDiff = await page.evaluate(() => !!(window as any).MANIFEST.files[0].diff);
    if (!hasDiff) test.skip();

    const diffCheckbox = page.locator('#layer-extras input[type="checkbox"]');
    const diffOverlay = page.locator('img[data-diff="1"]').first();

    // Default ON: overlay visible, checkbox checked
    await expect(diffCheckbox).toBeChecked();
    await expect(diffOverlay).not.toHaveCSS("display", "none");
    // Toggle off
    await diffCheckbox.uncheck();
    await expect(diffOverlay).toHaveCSS("display", "none");
    // Toggle back on
    await diffCheckbox.check();
    await expect(diffOverlay).not.toHaveCSS("display", "none");
  });

  test("view mode tabs work for schematic", async ({ page }) => {
    // Schematics with hasBefore=true should still get all 3 view modes
    await expect(page.locator("#view-tabs button")).toHaveCount(3);
    await page.click('button[data-view="ovl"]');
    await expect(page.locator("#view-ovl")).toHaveClass(/active/);
    await page.click('button[data-view="swp"]');
    await expect(page.locator("#view-swp")).toHaveClass(/active/);
  });
});

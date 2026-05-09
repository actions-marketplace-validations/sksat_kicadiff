import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
const SCH_HTML = path.join(
  FIXTURE_DIR,
  "PicoBridge_pcb_PicoBridge.kicad_sch_diff.html"
);

test.skip(() => !fs.existsSync(SCH_HTML), "schematic fixture not found");

test.beforeEach(async ({ page }) => {
  await page.goto(`file://${SCH_HTML}`);
  await page.waitForSelector("#view-sbs.active");
});

test.describe("Schematic viewer", () => {
  test("manifest type is sch", async ({ page }) => {
    const type = await page.evaluate(() => (window as any).MANIFEST.type);
    expect(type).toBe("sch");
  });

  test("layer panel is hidden for schematic", async ({ page }) => {
    // Schematics don't have PCB layers — panel should not be displayed
    const display = await page
      .locator("#layer-panel")
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

  test("view mode tabs work for schematic", async ({ page }) => {
    // Schematics with hasBefore=true should still get all 3 view modes
    await expect(page.locator("#view-tabs button")).toHaveCount(3);
    await page.click('button[data-view="ovl"]');
    await expect(page.locator("#view-ovl")).toHaveClass(/active/);
    await page.click('button[data-view="swp"]');
    await expect(page.locator("#view-swp")).toHaveClass(/active/);
  });
});

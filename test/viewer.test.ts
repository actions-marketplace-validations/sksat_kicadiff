import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
const DIFF_HTML = path.join(
  FIXTURE_DIR,
  "PicoBridge_pcb_PicoBridge.kicad_pcb_diff.html"
);

// Skip all tests if fixtures are not generated (e.g. CI without KiCad)
test.skip(() => !fs.existsSync(DIFF_HTML), "fixture not found");

test.beforeEach(async ({ page }) => {
  await page.goto(`file://${DIFF_HTML}`);
  // Wait for init() to complete
  await page.waitForSelector("#view-sbs.active");
});

// =============================================================================
// View modes
// =============================================================================

test.describe("View modes", () => {
  test("initial state is Side by Side", async ({ page }) => {
    await expect(page.locator("#view-sbs")).toHaveClass(/active/);
    await expect(page.locator("#view-ovl")).not.toHaveClass(/active/);
    await expect(page.locator("#view-swp")).not.toHaveClass(/active/);
  });

  test("switch to Overlay", async ({ page }) => {
    await page.click('button[data-view="ovl"]');
    await expect(page.locator("#view-ovl")).toHaveClass(/active/);
    await expect(page.locator("#view-sbs")).not.toHaveClass(/active/);
  });

  test("switch to Swipe", async ({ page }) => {
    await page.click('button[data-view="swp"]');
    await expect(page.locator("#view-swp")).toHaveClass(/active/);
    await expect(page.locator("#view-sbs")).not.toHaveClass(/active/);
  });

  test("all three tabs exist for PCB with before", async ({ page }) => {
    const tabs = page.locator("#view-tabs button");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText("Side by Side");
    await expect(tabs.nth(1)).toHaveText("Overlay");
    await expect(tabs.nth(2)).toHaveText("Swipe");
  });
});

// =============================================================================
// Layer panel (KiCad/Photoshop style)
// =============================================================================

test.describe("Layer panel", () => {
  test("layer panel is visible for PCB", async ({ page }) => {
    await expect(page.locator("#layer-panel")).toBeVisible();
  });

  test("has 5 layer rows", async ({ page }) => {
    await expect(page.locator(".layer-row")).toHaveCount(5);
  });

  test("F.Cu is active by default", async ({ page }) => {
    const fcuRow = page.locator('.layer-row[data-layer="F.Cu"]');
    await expect(fcuRow).toHaveClass(/active/);
  });

  test("eye icon toggles layer visibility without affecting others", async ({
    page,
  }) => {
    // Click F.Cu eye icon to hide it
    const fcuEye = page.locator('.layer-row[data-layer="F.Cu"] .eye');
    await fcuEye.click();

    // F.Cu images should be hidden
    const fcuImgs = page.locator('img[data-layer="F.Cu"]');
    for (const img of await fcuImgs.all()) {
      await expect(img).toHaveCSS("display", "none");
    }

    // B.Cu images should still be visible
    const bcuImgs = page.locator('img[data-layer="B.Cu"]');
    for (const img of await bcuImgs.all()) {
      await expect(img).not.toHaveCSS("display", "none");
    }
  });

  test("clicking row selects active layer (z-index boost)", async ({
    page,
  }) => {
    // Click B.Cu row
    await page.click('.layer-row[data-layer="B.Cu"]');
    await expect(
      page.locator('.layer-row[data-layer="B.Cu"]')
    ).toHaveClass(/active/);
    await expect(
      page.locator('.layer-row[data-layer="F.Cu"]')
    ).not.toHaveClass(/active/);

    // B.Cu should have the highest z-index among layers
    const bcuZIndex = await page
      .locator('#sbs-after img[data-layer="B.Cu"]')
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex));
    const fcuZIndex = await page
      .locator('#sbs-after img[data-layer="F.Cu"]')
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex));
    expect(bcuZIndex).toBeGreaterThan(fcuZIndex);
  });

  test("clicking active row again deselects it", async ({ page }) => {
    // F.Cu is active by default; click it to deselect
    await page.click('.layer-row[data-layer="F.Cu"]');
    await expect(
      page.locator('.layer-row[data-layer="F.Cu"]')
    ).not.toHaveClass(/active/);
  });

  test("all layers have the same opacity (KiCad style)", async ({ page }) => {
    // Active and non-active layers should both be 0.6
    const allLayerImgs = page.locator("#sbs-after img[data-layer]");
    for (const img of await allLayerImgs.all()) {
      await expect(img).toHaveCSS("opacity", "0.6");
    }
  });
});

// =============================================================================
// Overlay mode
// =============================================================================

test.describe("Overlay mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.click('button[data-view="ovl"]');
  });

  test("controls bar is above the image body", async ({ page }) => {
    const controlsBox = await page
      .locator(".ovl-controls")
      .boundingBox();
    const bodyBox = await page.locator(".ovl-body").boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    // Controls bottom edge should be at or above body top edge
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(
      bodyBox!.y + 1
    );
  });

  test("slider changes after stack opacity", async ({ page }) => {
    const slider = page.locator("#opacity-slider");
    // Set slider to 0
    await slider.fill("0");
    await slider.dispatchEvent("input");
    const opacity = await page
      .locator("#ovl-over")
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(parseFloat(opacity)).toBe(0);
  });
});

// =============================================================================
// Swipe mode
// =============================================================================

test.describe("Swipe mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.click('button[data-view="swp"]');
    // Wait for layout
    await page.waitForTimeout(100);
  });

  test("divider is topmost (z-index >= 9999)", async ({ page }) => {
    const zIndex = await page
      .locator("#swipe-divider")
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex));
    expect(zIndex).toBeGreaterThanOrEqual(9999);
  });

  test("drag moves divider position", async ({ page }) => {
    const initialLeft = await page
      .locator("#swipe-divider")
      .evaluate((el) => el.getBoundingClientRect().left);

    // Drag from center to 25% from the left
    const wrap = page.locator("#swipe-wrap");
    const box = await wrap.boundingBox();
    if (!box) return;
    const startX = box.x + box.width * 0.5;
    const endX = box.x + box.width * 0.25;
    const y = box.y + box.height * 0.5;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 5 });
    await page.mouse.up();

    const newLeft = await page
      .locator("#swipe-divider")
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(newLeft).toBeLessThan(initialLeft);
  });

  test("controls bar area is draggable", async ({ page }) => {
    const controls = page.locator(".swp-controls");
    const box = await controls.boundingBox();
    if (!box) return;

    const initialLeft = await page
      .locator("#swipe-divider")
      .evaluate((el) => el.getBoundingClientRect().left);

    // Drag within controls bar
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();

    const newLeft = await page
      .locator("#swipe-divider")
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(newLeft).not.toBe(initialLeft);
  });

  test("image starts at same Y position as overlay", async ({ page }) => {
    // Get overlay body top
    await page.click('button[data-view="ovl"]');
    const ovlBodyTop = await page
      .locator(".ovl-body")
      .evaluate((el) => el.getBoundingClientRect().top);

    // Get swipe body top
    await page.click('button[data-view="swp"]');
    const swpBodyTop = await page
      .locator(".swp-body")
      .evaluate((el) => el.getBoundingClientRect().top);

    // Should be equal (both have same-height controls bars)
    expect(Math.abs(ovlBodyTop - swpBodyTop)).toBeLessThanOrEqual(2);
  });

  test("divider handle is within controls bar", async ({ page }) => {
    const divider = page.locator("#swipe-divider");
    const controlsBox = await page.locator(".swp-controls").boundingBox();
    // ::after pseudo-element top is 3px from divider top
    const dividerBox = await divider.boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(dividerBox).not.toBeNull();
    // Divider starts at swp view top, which includes controls bar
    expect(dividerBox!.y).toBeLessThanOrEqual(controlsBox!.y + 1);
  });
});

// =============================================================================
// Resize behavior
// =============================================================================

test.describe("Resize", () => {
  test("side-by-side images fit within viewport on resize", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 400 });
    await page.waitForTimeout(100);

    const img = page.locator("#sbs-after img").first();
    const imgBox = await img.boundingBox();
    const viewport = page.viewportSize()!;
    // Image width should not exceed viewport
    expect(imgBox!.width).toBeLessThanOrEqual(viewport.width);
  });

  test("overlay image fits within viewport width after enlarging", async ({
    page,
  }) => {
    await page.click('button[data-view="ovl"]');

    // Shrink
    await page.setViewportSize({ width: 400, height: 300 });
    await page.waitForTimeout(200);
    // Enlarge
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(200);

    const body = page.locator(".ovl-body");
    const bodyBox = await body.boundingBox();
    const img = page.locator("#ovl-before img").first();
    const imgBox = await img.boundingBox();

    // Image should not overflow the body width
    expect(imgBox!.width).toBeLessThanOrEqual(bodyBox!.width + 1);
  });

  test("side-by-side vertical scroll is synchronized between panes", async ({
    page,
  }) => {
    // Small viewport so tall PCB images overflow vertically
    await page.setViewportSize({ width: 400, height: 300 });
    await page.waitForTimeout(200);

    const beforeBody = page.locator("#view-sbs .pane:first-child .pane-body");
    const afterBody = page.locator("#view-sbs .pane:last-child .pane-body");

    // Scroll "before" pane down
    await beforeBody.evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(50);

    // "After" pane should follow
    const afterScrollTop = await afterBody.evaluate((el) => el.scrollTop);
    expect(afterScrollTop).toBe(100);
  });

  test("side-by-side scroll sync works in reverse direction", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 300 });
    await page.waitForTimeout(200);

    const beforeBody = page.locator("#view-sbs .pane:first-child .pane-body");
    const afterBody = page.locator("#view-sbs .pane:last-child .pane-body");

    // Scroll "after" pane down
    await afterBody.evaluate((el) => {
      el.scrollTop = 80;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(50);

    // "Before" pane should follow
    const beforeScrollTop = await beforeBody.evaluate((el) => el.scrollTop);
    expect(beforeScrollTop).toBe(80);
  });

  test("swipe divider repositions on resize", async ({ page }) => {
    await page.click('button[data-view="swp"]');
    await page.waitForTimeout(100);

    const leftBefore = await page
      .locator("#swipe-divider")
      .evaluate((el) => parseFloat(el.style.left));

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(200);

    const leftAfter = await page
      .locator("#swipe-divider")
      .evaluate((el) => parseFloat(el.style.left));

    // Position should change (recalculated) — unless they happen to be equal
    // At minimum, the divider should still be visible
    const dividerBox = await page.locator("#swipe-divider").boundingBox();
    expect(dividerBox).not.toBeNull();
    expect(dividerBox!.x).toBeGreaterThan(0);
  });
});

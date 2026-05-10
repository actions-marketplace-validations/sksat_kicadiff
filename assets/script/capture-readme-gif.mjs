/**
 * Drive viewer.html through a scripted click-through and capture frames.
 *
 * Cursor motion is broken into segments with screenshots between, so the
 * GIF shows the cursor visibly travelling rather than teleporting between
 * clicks. The fake cursor + click ripple are injected via page.evaluate.
 *
 * Outputs:
 *   assets/screens/<step>.png   — per-step screenshots
 *   assets/kicadiff-demo.gif    — animated GIF assembled via ImageMagick
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(new URL("../..", import.meta.url).pathname);
const HTML = path.join(REPO, ".claude/preview/mcu-board_diff.html");
const OUT_DIR = path.join(REPO, "assets/screens");
const GIF_PATH = path.join(REPO, "assets/kicadiff-demo.gif");
const VIEWPORT = { width: 1280, height: 800 };

if (!fs.existsSync(HTML)) {
  console.error("missing diff HTML:", HTML);
  console.error("run `./kicadiff examples/mcu-board/` first");
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith(".png")) fs.unlinkSync(path.join(OUT_DIR, f));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORT });

const page = await ctx.newPage();
await page.goto("file://" + HTML);
await page.waitForSelector("#view-tabs button.active");

await page.evaluate(() => {
  const css = `
    #__demo_cursor {
      position: fixed; left: -100px; top: -100px; width: 22px; height: 22px;
      pointer-events: none; z-index: 2147483647;
    }
    #__demo_cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    .__demo_ripple {
      position: fixed; pointer-events: none; z-index: 2147483646;
      width: 14px; height: 14px; border-radius: 50%;
      background: rgba(255, 80, 80, .55); border: 2px solid #fff;
      transform: translate(-50%, -50%);
      animation: __demo_ripple_anim .55s ease-out forwards;
    }
    @keyframes __demo_ripple_anim {
      0%   { width: 14px; height: 14px; opacity: 1; }
      100% { width: 56px; height: 56px; opacity: 0; }
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const cursor = document.createElement("div");
  cursor.id = "__demo_cursor";
  cursor.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
    <polygon points="2,2 2,18 7,14 10.5,21 13,20 9.5,13 16,13" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;
  document.body.appendChild(cursor);

  document.addEventListener("mousemove", (e) => {
    cursor.style.left = e.clientX + "px";
    cursor.style.top = e.clientY + "px";
  }, true);
  document.addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    r.className = "__demo_ripple";
    r.style.left = e.clientX + "px";
    r.style.top = e.clientY + "px";
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }, true);
});

let frame = 0;
const shot = async (label) => {
  const file = path.join(OUT_DIR, `${String(frame).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("saved", path.relative(process.cwd(), file));
  frame++;
};
const wait = (ms) => page.waitForTimeout(ms);

// Segment count grows with travel distance so long jumps get more
// in-between frames (smoother motion); short hops stay snappy.
// One frame per ~80px of travel, capped so very long moves still finish
// in a reasonable number of frames.
function segmentsFor(dist) {
  if (dist < 50) return 1;
  return Math.min(12, Math.max(3, Math.round(dist / 80)));
}

let lastX = 40, lastY = 750;

// Smoothstep easing: slow-fast-slow, mimics natural pointer motion better
// than the constant-velocity Playwright default.
const easeInOut = (t) => t * t * (3 - 2 * t);

// Move cursor visibly: snapshot at each intermediate point so the GIF shows
// motion rather than a teleport. `label` keys the in-flight frames. Uses
// smoothstep so the cursor accelerates, cruises, then decelerates as it
// approaches the target.
async function moveTo(x, y, label) {
  const dist = Math.hypot(x - lastX, y - lastY);
  const segs = segmentsFor(dist);
  for (let i = 1; i <= segs; i++) {
    const t = easeInOut(i / segs);
    const ix = lastX + (x - lastX) * t;
    const iy = lastY + (y - lastY) * t;
    await page.mouse.move(ix, iy, { steps: 4 });
    if (label && i < segs) {
      await wait(35);
      await shot(`${label}-fly${i}`);
    }
  }
  lastX = x; lastY = y;
}

async function clickShot(selector, label) {
  const loc = page.locator(selector).first();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveTo(x, y, label);
  // Linger so it reads as "cursor arrived, paused, then clicked" rather
  // than auto-clicking the moment the cursor lands on the button.
  await wait(420);
  await shot(`${label}-hover`);
  await page.mouse.down();
  await page.mouse.up();
  await wait(450);
  await shot(label);
}

const tabByText = async (txt) => {
  const tabs = await page.locator("#file-tabs button").all();
  for (const t of tabs) {
    const s = (await t.innerText()).trim();
    if (s === txt) return t;
  }
  return null;
};
const pcbTab = await tabByText("PCB");
const schTab = await tabByText("Schematic");

// Park cursor below the layout so the first frame is uncluttered.
await page.mouse.move(40, 750, { steps: 5 });
lastX = 40; lastY = 750;
await wait(250);

/** Drag the swipe divider edge-to-edge with mid-drag snapshots. Headless
 *  Chromium drops some mousemove events when the drag is dispatched via
 *  Playwright's mouse API, so we synthesise the events directly on
 *  document — this matches the viewer's swp.addEventListener('mousedown')
 *  handler and lets the divider track the cursor reliably. */
async function dragSwipe(label) {
  const swpBox = await page.locator("#view-swp").boundingBox();
  if (!swpBox) return;

  // Sweep nearly edge-to-edge so the wipe covers the full board / sheet.
  // Grab at the swp-controls bar (near the top of the view) where the
  // divider handle visibly lives — grabbing mid-image reads weird since
  // there's no visible handle there.
  const ctrlBox = await page.locator("#view-swp .swp-controls").boundingBox();
  const grabY = ctrlBox ? ctrlBox.y + ctrlBox.height / 2 : swpBox.y + 12;
  const startX = swpBox.x + swpBox.width * 0.95;
  const endX = swpBox.x + swpBox.width * 0.05;
  const midY = grabY;

  // Travel cursor to start; pause so it reads as "lining up the grab",
  // then press "down" to grab the divider.
  await moveTo(startX, midY, `${label}-startfly`);
  await wait(450);
  await page.evaluate(({ x, y }) => {
    const swp = document.querySelector("#view-swp");
    swp.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }, { x: startX, y: midY });
  await wait(120);
  await shot(`${label}-grab`);

  // Sweep the divider edge-to-edge by emitting mousemove events directly on
  // document. Snapshot evenly spaced through the sweep for a smooth wipe.
  const dragFrames = 14;
  for (let i = 1; i <= dragFrames; i++) {
    const t = i / dragFrames;
    const cx = startX + (endX - startX) * t;
    // Update the fake cursor position too so the GIF shows it travelling.
    await page.evaluate(({ x, y }) => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    }, { x: cx, y: midY });
    await wait(40);
    if (i % 3 === 0 || i === dragFrames) await shot(`${label}-drag${i}`);
  }

  await page.evaluate(({ x, y }) => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
  }, { x: endX, y: midY });
  // Sync Playwright's mouse state to where the fake cursor ended up.
  await page.mouse.move(endX, midY);
  lastX = endX; lastY = midY;
  await wait(200);
}

// ---- PCB walk-through ----
if (pcbTab) {
  const pcbBox = await pcbTab.boundingBox();
  await moveTo(pcbBox.x + pcbBox.width / 2, pcbBox.y + pcbBox.height / 2, "pcb-tab");
  await wait(420);
  await shot("pcb-tab-hover");
  await pcbTab.click();
  await wait(500);
  await shot("pcb-overlay");

  await clickShot('#view-tabs button[data-view="sbs"]', "pcb-sbs");
  await clickShot('#view-tabs button[data-view="swp"]', "pcb-swipe");
  await dragSwipe("pcb-swipe");
}

// ---- Schematic walk-through ----
if (schTab) {
  const schBox = await schTab.boundingBox();
  await moveTo(schBox.x + schBox.width / 2, schBox.y + schBox.height / 2, "sch-tab");
  await wait(420);
  await shot("sch-tab-hover");
  await schTab.click();
  await wait(500);
  await shot("sch-overlay");

  await clickShot('#view-tabs button[data-view="sbs"]', "sch-sbs");
  await clickShot('#view-tabs button[data-view="swp"]', "sch-swipe");
  await dragSwipe("sch-swipe");
}

await browser.close();

const frames = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.endsWith(".png"))
  .sort()
  .map((f) => path.join(OUT_DIR, f));

if (!frames.length) {
  console.error("no frames captured");
  process.exit(1);
}

fs.mkdirSync(path.dirname(GIF_PATH), { recursive: true });

// Per-frame delays (centiseconds). Tuned so motion reads as a calm
// demonstration: in-flight cursor frames are short (smooth motion), but
// hover/result frames linger so the eye can settle on what just happened.
function delayFor(filename, idx, total) {
  if (/-fly\d+\.png$|-startfly/.test(filename)) return "16"; // in-flight cursor
  if (/-drag\d+\.png$/.test(filename)) return "22";          // mid-drag
  if (/-grab\.png$/.test(filename)) return "70";             // grabbed, before drag
  if (/-hover\.png$/.test(filename)) return "55";            // arrived, about to click
  if (/-end\.png$/.test(filename)) return "200";             // settle after drag
  if (/-overlay\.png$/.test(filename)) return "260";         // file-tab click result
  if (idx === total - 1) return "400";                       // pause before loop
  return "230";                                              // view-tab click result
}

const args = [];
for (let i = 0; i < frames.length; i++) {
  args.push("-delay", delayFor(frames[i], i, frames.length), frames[i]);
}
args.push("-loop", "0", "-resize", "960x", "-layers", "OptimizePlus", GIF_PATH);
execFileSync("magick", args, { stdio: "inherit" });
const stat = fs.statSync(GIF_PATH);
console.log(`gif: ${path.relative(process.cwd(), GIF_PATH)} (${(stat.size / 1024).toFixed(1)} KB, ${frames.length} frames)`);

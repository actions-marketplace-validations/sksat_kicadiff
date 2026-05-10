/**
 * Composite per-layer PCB renders into a single "combined" PNG that
 * mirrors what the HTML viewer shows: each available layer drawn at
 * 0.6 opacity over a dark canvas, with the active layer (F.Cu by
 * default) on top.
 *
 * The kicad-cli combined SVG/PNG export gives a flat layered drawing
 * dominated by whatever copper layer KiCad chose to render last, so
 * PR-embedded thumbnails would end up with B.Cu obscuring everything
 * even though the viewer puts F.Cu on top with everything translucent.
 * We replace that combined PNG with this composite so the embed
 * matches the interactive view.
 *
 * Layer order and opacity here are kept deliberately in lock-step
 * with viewer.html's LAYER_ORDER + applyLayers (`opacity: 0.6`,
 * active layer's zIndex bumped above the others).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";

/** Bottom-to-top base z-order. F.Cu's effective z-index gets bumped
 *  to the top by the active-layer rule below; everything else stays
 *  at its index in this array. Mirrors viewer.html's LAYER_ORDER. */
const LAYER_ORDER = [
  "Edge.Cuts",
  "B.Silkscreen",
  "B.Cu",
  "F.Cu",
  "F.Silkscreen",
] as const;

/** Default active layer the viewer selects on load. */
const ACTIVE_LAYER = "F.Cu";

/** Per-layer global opacity multiplier (matches viewer's
 *  `img.style.opacity = '0.6'`). */
const LAYER_OPACITY = 0.6;

/** Canvas background. Matches the viewer body's `background:#1e1e1e`
 *  so the composited PNG looks the same standalone as it does in the
 *  viewer's layer stack. */
const BACKGROUND: readonly [number, number, number] = [0x1e, 0x1e, 0x1e];

/** Map a kicad-cli per-layer filename to its layer name.
 *  e.g. `preview_xxx-F_Cu.png` → `F.Cu`. Pulled out as a separate
 *  function so tests can exercise the parsing in isolation. */
export function layerNameFromFile(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const layerToken = stem.split("-").pop() ?? stem;
  return layerToken.replace(/_/g, ".");
}

/** Sort the available layers in render order (bottom first). The
 *  active layer is pinned to the end (top of the stack) regardless
 *  of its base index, matching viewer.applyLayers's z-index logic. */
function renderOrder(present: readonly string[]): string[] {
  return [...present].sort((a, b) => zIndex(a) - zIndex(b));
}

function zIndex(name: string): number {
  if (name === ACTIVE_LAYER) return 1_000_000; // always on top
  const idx = LAYER_ORDER.indexOf(name as typeof LAYER_ORDER[number]);
  return idx === -1 ? -1 : idx;
}

/** Composite the per-layer PNGs from `layersDir` into `outputPng`.
 *  Returns true when a composite was produced, false when the
 *  directory had no recognised layer files (caller can fall back).
 *  Throws on dimension mismatch — that's a rendering bug, not a
 *  recoverable condition. */
export function compositePcbLayers(layersDir: string, outputPng: string): boolean {
  if (!fs.existsSync(layersDir)) return false;

  const files = fs.readdirSync(layersDir).filter((f) => f.endsWith(".png"));
  const byName: Record<string, string> = {};
  for (const f of files) {
    const name = layerNameFromFile(f);
    if ((LAYER_ORDER as readonly string[]).includes(name)) {
      byName[name] = path.join(layersDir, f);
    }
  }
  const order = renderOrder(Object.keys(byName));
  if (order.length === 0) return false;

  // Sample the first layer to size the canvas. All per-layer PNGs are
  // produced from the same SVG export with the same `--page-size-mode`,
  // so they're guaranteed to share dimensions; we still validate below.
  const first = PNG.sync.read(fs.readFileSync(byName[order[0]]));
  const w = first.width;
  const h = first.height;

  const canvas = new PNG({ width: w, height: h });
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = BACKGROUND[0];
    canvas.data[i + 1] = BACKGROUND[1];
    canvas.data[i + 2] = BACKGROUND[2];
    canvas.data[i + 3] = 255;
  }

  for (const layerName of order) {
    const layer = PNG.sync.read(fs.readFileSync(byName[layerName]));
    if (layer.width !== w || layer.height !== h) {
      throw new Error(
        `compositePcbLayers: dimension mismatch on ${layerName} (${layer.width}x${layer.height} vs ${w}x${h})`,
      );
    }
    blendOver(canvas, layer, LAYER_OPACITY);
  }

  fs.writeFileSync(outputPng, PNG.sync.write(canvas));
  return true;
}

/** Porter-Duff "over" composite of `src` onto `dst` (in place on dst),
 *  with a global opacity multiplier applied to the source. Both buffers
 *  are RGBA, same dimensions, dst assumed opaque. */
function blendOver(dst: PNG, src: PNG, globalOpacity: number): void {
  const len = dst.data.length;
  for (let i = 0; i < len; i += 4) {
    const sa = src.data[i + 3];
    if (sa === 0) continue; // fully transparent → no contribution

    // Effective source alpha in 0..1, accounting for the global
    // opacity multiplier. With dst already opaque the output stays
    // opaque so we don't need to track alpha through the math.
    const a = (sa / 255) * globalOpacity;
    const ia = 1 - a;
    dst.data[i]     = Math.round(src.data[i]     * a + dst.data[i]     * ia);
    dst.data[i + 1] = Math.round(src.data[i + 1] * a + dst.data[i + 1] * ia);
    dst.data[i + 2] = Math.round(src.data[i + 2] * a + dst.data[i + 2] * ia);
    // dst.data[i + 3] stays 255
  }
}

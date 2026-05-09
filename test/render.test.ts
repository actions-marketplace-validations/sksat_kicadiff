import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Integration tests for the kicadiff CLI.
 * These spawn the actual CLI and inspect the generated files.
 * Migrated from test/render.test.sh.
 */

const PROJECT_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PROJECT_DIR, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
const PCB_FILE = path.join(REPO_ROOT, "PicoBridge/pcb/PicoBridge.kicad_pcb");
const SCH_FILE = path.join(REPO_ROOT, "PicoBridge/pcb/PicoBridge.kicad_sch");
const SAFE_PCB = "PicoBridge_pcb_PicoBridge.kicad_pcb";
const SAFE_SCH = "PicoBridge_pcb_PicoBridge.kicad_sch";

/** Run kicadiff CLI and return its exit code, capturing stderr for diagnostics. */
function runCli(args: string[], options: { allowFailure?: boolean } = {}): { status: number; stderr: string } {
  const r = spawnSync("bash", [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = r.status ?? 1;
  if (!options.allowFailure && status !== 0) {
    throw new Error(`kicadiff failed (${status}): ${r.stderr}`);
  }
  return { status, stderr: r.stderr ?? "" };
}

/** Read the manifest JSON injected into a generated diff HTML. */
function readManifest(htmlPath: string): unknown {
  const html = fs.readFileSync(htmlPath, "utf8");
  // Match: <script>window.MANIFEST = {...};</script>
  const m = html.match(/window\.MANIFEST = (\{.*?\});<\/script>/);
  if (!m) throw new Error("manifest not found in HTML");
  return JSON.parse(m[1]);
}

let outputDir: string;

test.beforeAll(() => {
  // Skip the entire suite if the source PCB isn't available
  if (!fs.existsSync(PCB_FILE)) test.skip(true, `KiCad fixture missing: ${PCB_FILE}`);
});

test.beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-test-"));
});

test.afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

// =============================================================================
// PCB rendering
// =============================================================================

test.describe("PCB rendering", () => {
  test("generates combined PNG with non-zero size", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const png = path.join(outputDir, `after/${SAFE_PCB}.png`);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.statSync(png).size).toBeGreaterThan(0);
  });

  test("generates per-layer PNGs for all 5 layers", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const layersDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const expected = ["F_Cu", "B_Cu", "F_Silkscreen", "B_Silkscreen", "Edge_Cuts"];
    for (const layer of expected) {
      const found = fs.readdirSync(layersDir).find(f => f.endsWith(`-${layer}.png`));
      expect(found, `missing layer ${layer}`).toBeTruthy();
    }
  });

  test("layer PNGs have consistent dimensions and RGBA mode", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const layersDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const pngs = fs.readdirSync(layersDir).filter(f => f.endsWith(".png"));

    const infos = pngs.map(f => {
      const out = execFileSync("python3", [
        "-c",
        "import sys;from PIL import Image;img=Image.open(sys.argv[1]);print(f'{img.size[0]}x{img.size[1]} {img.mode}')",
        path.join(layersDir, f),
      ], { encoding: "utf8" }).trim();
      return out;
    });

    expect(new Set(infos).size).toBe(1);          // all identical
    expect(infos[0]).toMatch(/RGBA/);              // transparent
  });

  test("generates before image and identical layer PNGs (file unchanged)", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const beforePng = path.join(outputDir, `before/${SAFE_PCB}.png`);
    expect(fs.existsSync(beforePng)).toBe(true);

    // For an unchanged file, before/after layer PNGs should be byte-identical
    const afterDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const beforeDir = path.join(outputDir, `before/layers_${SAFE_PCB}`);

    for (const f of fs.readdirSync(afterDir).filter(x => x.endsWith(".png"))) {
      const layer = f.split("-").pop();
      const beforeMatch = fs.readdirSync(beforeDir).find(x => x.endsWith(`-${layer}`));
      expect(beforeMatch, `no before match for ${layer}`).toBeTruthy();
      const a = fs.readFileSync(path.join(afterDir, f));
      const b = fs.readFileSync(path.join(beforeDir, beforeMatch!));
      expect(a.equals(b)).toBe(true);
    }
  });

  test("generates diff highlight PNG", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `diff/${SAFE_PCB}.png`))).toBe(true);
  });
});

// =============================================================================
// HTML and manifest
// =============================================================================

test.describe("HTML output", () => {
  test("generates diff HTML that contains MANIFEST and viewer content", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const htmlPath = path.join(outputDir, `${SAFE_PCB}_diff.html`);
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("window.MANIFEST");
    expect(html).toContain("KiCad Diff");
  });

  test("manifest has required keys for PCB", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, `${SAFE_PCB}_diff.html`)) as any;
    expect(m.file).toBeTruthy();
    expect(m.type).toBe("pcb");
    expect(m.hasBefore).toBe(true);
    expect(m.after?.combined).toBeTruthy();
    expect(Object.keys(m.after?.layers ?? {})).toHaveLength(5);
    expect(m.before?.combined).toBeTruthy();
    expect(Object.keys(m.before?.layers ?? {})).toHaveLength(5);
    expect(m.diff).toBeTruthy();
  });
});

// =============================================================================
// CLI behavior
// =============================================================================

test.describe("CLI argument handling", () => {
  test("rejects non-KiCad files", () => {
    const tmp = path.join(outputDir, "not-kicad.txt");
    fs.writeFileSync(tmp, "");
    const r = runCli([tmp, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("respects --output-dir", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-custom-"));
    try {
      runCli([PCB_FILE, "--output-dir", customDir]);
      expect(fs.existsSync(path.join(customDir, `${SAFE_PCB}_diff.html`))).toBe(true);
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("pcb subcommand rejects .kicad_sch files", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    const r = runCli(["pcb", SCH_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("sch subcommand rejects .kicad_pcb files", () => {
    const r = runCli(["sch", PCB_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("--images-only skips HTML generation", () => {
    runCli([PCB_FILE, "--output-dir", outputDir, "--images-only"]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `${SAFE_PCB}_diff.html`))).toBe(false);
  });
});

// =============================================================================
// Schematic rendering
// =============================================================================

test.describe("Schematic rendering", () => {
  test("generates combined PNG and HTML with type=sch", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);

    const png = path.join(outputDir, `after/${SAFE_SCH}.png`);
    const html = path.join(outputDir, `${SAFE_SCH}_diff.html`);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.statSync(png).size).toBeGreaterThan(0);
    expect(fs.existsSync(html)).toBe(true);

    const m = readManifest(html) as any;
    expect(m.type).toBe("sch");
  });
});

// =============================================================================
// Git ref handling (--from / --to)
// =============================================================================

test.describe("Git ref handling", () => {
  test("--from HEAD --to working tree (default) works", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `before/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
  });

  test("explicit --from HEAD produces same result as default", () => {
    runCli([PCB_FILE, "--from", "HEAD", "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, `${SAFE_PCB}_diff.html`)) as any;
    expect(m.hasBefore).toBe(true);
  });
});

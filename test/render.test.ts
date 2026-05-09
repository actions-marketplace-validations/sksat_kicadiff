import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests for the kicadiff CLI.
 * These spawn the actual CLI and inspect the generated files.
 * Migrated from test/render.test.sh.
 */

const PROJECT_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PROJECT_DIR, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
const PROJECT_FIXTURE_DIR = path.join(REPO_ROOT, "PicoBridge/pcb");
const PCB_FILE = path.join(PROJECT_FIXTURE_DIR, "PicoBridge.kicad_pcb");
const SCH_FILE = path.join(PROJECT_FIXTURE_DIR, "PicoBridge.kicad_sch");
const PRO_FILE = path.join(PROJECT_FIXTURE_DIR, "PicoBridge.kicad_pro");
const SAFE_PCB = "PicoBridge_pcb_PicoBridge.kicad_pcb";
const SAFE_SCH = "PicoBridge_pcb_PicoBridge.kicad_sch";
const PROJECT_HTML = "PicoBridge_diff.html"; // combined HTML name from projectSafeName

/** Run kicadiff CLI and return its exit code, capturing stderr for diagnostics.
 *  CLI is a symlink to src/index.ts with `#!/usr/bin/env node` shebang —
 *  Node 25+ runs TS directly. */
function runCli(
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): { status: number; stderr: string } {
  const r = spawnSync(CLI, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  const status = r.status ?? 1;
  if (!options.allowFailure && status !== 0) {
    throw new Error(`kicadiff failed (${status}): ${r.stderr}`);
  }
  return { status, stderr: r.stderr ?? "" };
}

/** Create a mock "opener" script that records its argv to a log file.
 *  Returns the script path and the log path. */
function makeOpenerMock(dir: string): { script: string; log: string } {
  const log = path.join(dir, "open.log");
  const script = path.join(dir, "fake-opener.sh");
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n`);
  fs.chmodSync(script, 0o755);
  return { script, log };
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
    const htmlPath = path.join(outputDir, PROJECT_HTML);
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("window.MANIFEST");
    expect(html).toContain("KiCad Diff");
  });

  test("manifest has required keys for PCB", () => {
    runCli(["pcb", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files).toHaveLength(1);
    const pcb = m.files[0];
    expect(pcb.file).toBeTruthy();
    expect(pcb.type).toBe("pcb");
    expect(pcb.hasBefore).toBe(true);
    expect(pcb.after?.combined).toBeTruthy();
    expect(Object.keys(pcb.after?.layers ?? {})).toHaveLength(5);
    expect(pcb.before?.combined).toBeTruthy();
    expect(Object.keys(pcb.before?.layers ?? {})).toHaveLength(5);
    expect(pcb.diff).toBeTruthy();
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
      expect(fs.existsSync(path.join(customDir, PROJECT_HTML))).toBe(true);
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

  test("`schematic` is an alias for `sch`", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["schematic", SCH_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`schematic` alias rejects .kicad_pcb", () => {
    const r = runCli(["schematic", PCB_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("--images-only skips HTML generation", () => {
    runCli([PCB_FILE, "--output-dir", outputDir, "--images-only"]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
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
    const html = path.join(outputDir, PROJECT_HTML);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.statSync(png).size).toBeGreaterThan(0);
    expect(fs.existsSync(html)).toBe(true);

    const m = readManifest(html) as any;
    expect(m.files[0].type).toBe("sch");
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
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });
});

// =============================================================================
// git diff-compatible positional ref syntax
// =============================================================================

test.describe("git diff compatible CLI", () => {
  test("single positional ref: `kicadiff <ref> <file>`", () => {
    runCli(["HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("two positional refs: `kicadiff <r1> <r2> <file>`", () => {
    runCli(["HEAD", "HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    // Both sides rendered from HEAD — should match
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("`..` range syntax: `kicadiff <r1>..<r2> <file>`", () => {
    runCli(["HEAD..HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("`--` separator: `kicadiff <ref> -- <file>`", () => {
    // Flags must come before `--` (everything after `--` is a path)
    runCli(["--output-dir", outputDir, "HEAD", "--", PCB_FILE]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("rejects three positional refs", () => {
    const r = runCli(
      ["HEAD", "HEAD", "HEAD", PCB_FILE, "--output-dir", outputDir],
      { allowFailure: true },
    );
    expect(r.status).not.toBe(0);
  });

  test("rejects bad ref", () => {
    const r = runCli(
      ["this-ref-does-not-exist", PCB_FILE, "--output-dir", outputDir],
      { allowFailure: true },
    );
    expect(r.status).not.toBe(0);
  });
});

// =============================================================================
// --open flag and KICADIFF_OPEN_CMD mock
// =============================================================================

test.describe("auto-open behavior", () => {
  test("default: no open command is invoked", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    // Without --open, the command should never run regardless of env
    expect(fs.existsSync(log)).toBe(false);
  });

  test("--open invokes the configured opener", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain(PROJECT_HTML);
  });

  test("--open vscode is parsed as a known target", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open", "vscode"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(true);
  });

  test("--open=<cmd> accepts arbitrary command via `=` syntax", () => {
    const { script, log } = makeOpenerMock(outputDir);
    // Explicitly clear KICADIFF_OPEN_CMD (which global-setup sets to "" as a
    // safety default) so that the CLI's --open=<cmd> resolution kicks in.
    const env = { ...process.env };
    delete env.KICADIFF_OPEN_CMD;
    runCli([PCB_FILE, "--output-dir", outputDir, `--open=${script}`], { env });
    expect(fs.existsSync(log)).toBe(true);
  });

  test("KICADIFF_OPEN_CMD='' suppresses open even with --open", () => {
    const log = path.join(outputDir, "open.log");
    runCli([PCB_FILE, "--output-dir", outputDir, "--open"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(fs.existsSync(log)).toBe(false);
  });

  test("--images-only does not produce HTML or trigger open", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open", "--images-only"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
  });
});

// =============================================================================
// Combined mode: render both PCB and schematic together when no subcommand
// =============================================================================

test.describe("combined PCB + schematic", () => {
  test("project directory input renders both files", () => {
    runCli([PROJECT_FIXTURE_DIR, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`.kicad_pro` input renders both siblings", () => {
    if (!fs.existsSync(PRO_FILE)) test.skip();
    runCli([PRO_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("single .kicad_pcb auto-includes sibling .kicad_sch", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`pcb` subcommand scopes to PCB only (no sch rendered)", () => {
    runCli(["pcb", PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(false);
  });

  test("`sch` subcommand scopes to schematic only (no pcb rendered)", () => {
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(false);
  });

  test("combined HTML manifest contains files array with both entries", () => {
    runCli([PROJECT_FIXTURE_DIR, "--output-dir", outputDir]);
    // Find any *_diff.html in the output (project-level entry)
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
    const html = fs.readFileSync(path.join(outputDir, htmls[0]), "utf8");
    const m = html.match(/window\.MANIFEST = (\{.*?\});<\/script>/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    expect(Array.isArray(parsed.files)).toBe(true);
    const types = parsed.files.map((f: any) => f.type).sort();
    expect(types).toEqual(["pcb", "sch"]);
  });
});

// =============================================================================
// Multi-sheet schematic — pages field in manifest (length >= 1, root first)
// =============================================================================

test.describe("schematic pages", () => {
  test("manifest includes a pages array with the root sheet", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const sch = m.files.find((f: any) => f.type === "sch");
    expect(sch).toBeTruthy();
    expect(Array.isArray(sch.after.pages)).toBe(true);
    expect(sch.after.pages.length).toBeGreaterThanOrEqual(1);
    // Root page name = schematic basename
    expect(sch.after.pages[0].name).toBe("PicoBridge");
  });

  test("before- and after-side page names match (stable across temp files)", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const sch = m.files[0];
    if (!sch.before?.pages) return;
    const after = sch.after.pages.map((p: any) => p.name);
    const before = sch.before.pages.map((p: any) => p.name);
    expect(before).toEqual(after);
  });
});

// =============================================================================
// --output flag: HTML at custom path, image paths rewritten to relative
// =============================================================================

test.describe("--output flag", () => {
  test("writes HTML to the specified path with relative image paths", () => {
    const htmlPath = path.join(outputDir, "custom/diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, "--output", htmlPath]);
    expect(fs.existsSync(htmlPath)).toBe(true);
    // Default location should NOT be used
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
    const m = readManifest(htmlPath) as any;
    // Image paths must resolve from the HTML's directory ("../after/...")
    expect(m.files[0].after.combined).toMatch(/^\.\.\/after\//);
  });

  test("--output=<path> works via `=` syntax", () => {
    const htmlPath = path.join(outputDir, "diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, `--output=${htmlPath}`]);
    expect(fs.existsSync(htmlPath)).toBe(true);
  });

  test("-o is an alias for --output", () => {
    const htmlPath = path.join(outputDir, "diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, "-o", htmlPath]);
    expect(fs.existsSync(htmlPath)).toBe(true);
  });
});

// =============================================================================
// --text-only: structural text diff (no SVG/PNG/HTML)
// =============================================================================

test.describe("--text-only", () => {
  /** Run CLI capturing stdout (--text-only writes the diff there). */
  function runWithStdout(args: string[]): { status: number; stdout: string } {
    const r = spawnSync(CLI, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  }

  test("prints summary line for PCB and skips HTML/PNG generation", () => {
    const r = runWithStdout(["--text-only", PCB_FILE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PicoBridge\.kicad_pcb \(pcb\): \+\d+ -\d+ ~\d+ =\d+/);
    // No images or HTML produced
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
  });

  test("detects value changes in modified PCB", () => {
    // Create an isolated git repo with a modified PCB to verify diff detection
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-textdiff-"));
    try {
      fs.cpSync(path.dirname(PCB_FILE), tmp, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "add", "."], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: tmp });
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      const orig = fs.readFileSync(pcbInTmp, "utf8");
      fs.writeFileSync(pcbInTmp, orig.replace(/100nF/g, "200nF"));

      const r = spawnSync(CLI, ["--text-only", pcbInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/~\s*C\d+\s+value: 100nF → 200nF/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Symbol library (.kicad_sym) and footprint (.kicad_mod) rendering
// =============================================================================

const SYM_LIB = path.join(REPO_ROOT, "kicad-lib/jlc-basic.kicad_sym");
const FP_FILE = path.join(REPO_ROOT, "kicad-lib/jlc-basic.pretty/C0402.kicad_mod");

test.describe("symbol library rendering", () => {
  test("`sym` subcommand renders one PNG per symbol", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["sym", SYM_LIB, "--output-dir", outputDir]);
    const safe = "kicad-lib_jlc-basic.kicad_sym";
    const itemsDir = path.join(outputDir, `after/items_${safe}`);
    expect(fs.existsSync(itemsDir)).toBe(true);
    const pngs = fs.readdirSync(itemsDir).filter(f => f.endsWith(".png"));
    expect(pngs.length).toBeGreaterThan(1);
  });

  test("manifest exposes pages list for sym file type", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["sym", SYM_LIB, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    const m = readManifest(path.join(outputDir, htmls[0])) as any;
    expect(m.files[0].type).toBe("sym");
    expect(Array.isArray(m.files[0].after.pages)).toBe(true);
    expect(m.files[0].after.pages.length).toBeGreaterThan(1);
  });

  test("`symbol` is an alias for `sym`", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["symbol", SYM_LIB, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
  });
});

test.describe("footprint rendering", () => {
  test("`fp` subcommand renders a single .kicad_mod", () => {
    if (!fs.existsSync(FP_FILE)) test.skip();
    runCli(["fp", FP_FILE, "--output-dir", outputDir]);
    const safe = "kicad-lib_jlc-basic.pretty_C0402.kicad_mod";
    expect(fs.existsSync(path.join(outputDir, `after/${safe}.png`))).toBe(true);
    const itemsDir = path.join(outputDir, `after/items_${safe}`);
    expect(fs.existsSync(path.join(itemsDir, "C0402.png"))).toBe(true);
  });

  test("`footprint` is an alias for `fp`", () => {
    if (!fs.existsSync(FP_FILE)) test.skip();
    runCli(["footprint", FP_FILE, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
  });

  test("`fp` subcommand accepts a .pretty directory and renders all footprints", () => {
    const prettyDir = path.dirname(FP_FILE);
    if (!fs.existsSync(prettyDir)) test.skip();
    runCli(["fp", prettyDir, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
    const m = readManifest(path.join(outputDir, htmls[0])) as any;
    // Multiple .kicad_mod files = multiple file entries
    expect(m.files.length).toBeGreaterThan(1);
    expect(m.files.every((f: any) => f.type === "fp")).toBe(true);
  });
});

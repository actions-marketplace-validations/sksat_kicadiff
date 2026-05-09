/**
 * kicadiff core rendering logic.
 *
 * Generates Before/After images and diff HTML for a KiCad file.
 * Migrated from render.sh — see git history for the bash version.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import which from "which";
import type { FileType, Manifest, SideManifest } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PCB_LAYERS = "F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts";
const REQUIRED_TOOLS = ["kicad-cli", "rsvg-convert", "python3"] as const;

export interface RenderOptions {
  /** Path to .kicad_pcb or .kicad_sch file (absolute or relative) */
  filePath: string;
  /** Output directory (defaults to <repo>/.claude/preview) */
  outputDir?: string;
  /** Skip HTML generation and VSCode auto-open */
  imagesOnly?: boolean;
  /** "Before" git ref. Default: "HEAD".
   *  Special value "" or "working" means use the working tree (no before render). */
  fromRef?: string;
  /** "After" git ref. Default: "" (working tree). Use a ref name to compare two commits. */
  toRef?: string;
  /** Open the resulting HTML after rendering.
   *   - undefined: don't auto-open (default)
   *   - "xdg": xdg-open (system default)
   *   - "vscode": `code -r` (VSCode tab)
   *   - any other string: treated as an executable name (e.g. "firefox",
   *     "chromium"); spawned with the HTML path as its argument.
   *  Override with KICADIFF_OPEN_CMD env var (full command, html path appended). */
  open?: string;
}

export interface RenderResult {
  filePath: string;
  relPath: string;
  fileType: FileType;
  outputDir: string;
  afterPng: string;
  beforePng?: string;
  diffPng?: string;
  diffHtml?: string;
  manifest: Manifest;
}

// =============================================================================
// Helpers
// =============================================================================

/** Check if a command is available on $PATH (uses npm `which`). */
function hasCommand(cmd: string): boolean {
  return which.sync(cmd, { nothrow: true }) !== null;
}

function checkDependencies(): void {
  for (const tool of REQUIRED_TOOLS) {
    if (!hasCommand(tool)) {
      throw new Error(`required command not found: ${tool}`);
    }
  }
}

/** Run a command, capturing stderr for error messages, suppressing stdout. */
function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} failed (exit ${r.status}): ${args.join(" ")}`
    );
  }
}

/** Run a command, ignoring failures (used for optional tools like ImageMagick). */
function tryRun(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
  return r.status === 0;
}

/** Sanitize a path into an allowlisted filename. */
function safeName(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getRepoRoot(filePath: string): string | null {
  const r = spawnSync("git", ["-C", path.dirname(filePath), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function gitHasFileAtRef(repoRoot: string, ref: string, relPath: string): boolean {
  const r = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${relPath}`]);
  return r.status === 0;
}

function gitShowToFile(repoRoot: string, ref: string, relPath: string, dest: string): void {
  // KiCad files can be large (multiple MB) — use a generous buffer (32 MB)
  const out = execFileSync("git", ["-C", repoRoot, "show", `${ref}:${relPath}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(dest, out);
}

/** Create a temp file in the same directory as `nearFile`, preserving its extension.
 *  Same dir is required so kicad-cli can resolve .kicad_pro / library paths. */
function makeTempBeside(nearFile: string): string {
  const dir = path.dirname(nearFile);
  const ext = path.extname(nearFile); // includes the dot
  // Random component matches `mktemp -p ... preview_XXXXXX.<ext>` style
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = path.join(dir, `preview_${rand}${ext}`);
  fs.writeFileSync(tmp, "");
  return tmp;
}

// =============================================================================
// Rendering primitives
// =============================================================================

function renderPcbCombined(input: string, outputSvg: string): void {
  run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-single",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", outputSvg,
    input,
  ]);
}

function renderPcbLayers(input: string, outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-multi",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", `${outputDir}/`,
    input,
  ]);
  // Convert each generated SVG to PNG (preserving alpha)
  for (const f of fs.readdirSync(outputDir)) {
    if (!f.endsWith(".svg")) continue;
    const svg = path.join(outputDir, f);
    const png = svg.replace(/\.svg$/, ".png");
    run("rsvg-convert", ["-w", "1600", svg, "-o", png]);
  }
}

function renderSch(input: string, outputDir: string, outputSvg: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  run("kicad-cli", [
    "sch", "export", "svg",
    "--exclude-drawing-sheet",
    "--no-background-color",
    "-o", outputDir,
    input,
  ]);
  // kicad-cli sch export auto-names output by input file basename
  const baseName = path.basename(input, ".kicad_sch");
  const generated = path.join(outputDir, `${baseName}.svg`);
  if (fs.existsSync(generated) && generated !== outputSvg) {
    fs.renameSync(generated, outputSvg);
  }
}

function svgToPng(svg: string, png: string): void {
  if (fs.existsSync(svg)) {
    run("rsvg-convert", ["-w", "1600", svg, "-o", png]);
  }
}

// =============================================================================
// Manifest construction
// =============================================================================

function buildLayerMap(layersDir: string, side: "before" | "after", safe: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!fs.existsSync(layersDir)) return map;
  const files = fs.readdirSync(layersDir).filter(f => f.endsWith(".png")).sort();
  for (const f of files) {
    // Filename like "BoardName-F_Cu.png" — extract layer after last hyphen
    const stem = f.replace(/\.png$/, "");
    const layerToken = stem.split("-").pop() ?? stem;
    const layerName = layerToken.replace(/_/g, ".");
    map[layerName] = `${side}/layers_${safe}/${f}`;
  }
  return map;
}

function buildManifest(args: {
  relPath: string;
  fileType: FileType;
  outputDir: string;
  safe: string;
  hasBefore: boolean;
  diffPng?: string;
}): Manifest {
  const { relPath, fileType, outputDir, safe, hasBefore, diffPng } = args;
  const after: SideManifest = {
    combined: `after/${safe}.png`,
    layers: buildLayerMap(path.join(outputDir, `after/layers_${safe}`), "after", safe),
  };
  const m: Manifest = { file: relPath, type: fileType, hasBefore, after };
  if (hasBefore) {
    m.before = {
      combined: `before/${safe}.png`,
      layers: buildLayerMap(path.join(outputDir, `before/layers_${safe}`), "before", safe),
    };
  }
  if (diffPng && fs.existsSync(diffPng)) {
    m.diff = `diff/${safe}.png`;
  }
  return m;
}

/** Inject the manifest into viewer.html as a <script> tag.
 *  </script> in JSON is escaped to prevent breaking out of the script tag. */
function buildHtml(viewerPath: string, manifest: Manifest): string {
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  const viewerContent = fs.readFileSync(viewerPath, "utf8");
  return `<script>window.MANIFEST = ${json};</script>\n${viewerContent}`;
}

// =============================================================================
// Main entry
// =============================================================================

export function render(opts: RenderOptions): RenderResult {
  checkDependencies();

  // --- Resolve absolute file path ---
  let filePath = opts.filePath;
  if (!path.isAbsolute(filePath)) filePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  // --- Determine file type from extension ---
  let fileType: FileType;
  if (filePath.endsWith(".kicad_pcb")) fileType = "pcb";
  else if (filePath.endsWith(".kicad_sch")) fileType = "sch";
  else throw new Error(`not a KiCad file: ${filePath}`);

  // --- Determine repo root and relative path ---
  const repoRoot = getRepoRoot(filePath);
  const relPath = repoRoot
    ? path.relative(repoRoot, filePath)
    : path.basename(filePath);

  // --- Determine output directory ---
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : repoRoot
      ? path.join(repoRoot, ".claude/preview")
      : path.join(os.tmpdir(), "kicadiff-preview");

  fs.mkdirSync(path.join(outputDir, "before"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "after"), { recursive: true });

  const safe = safeName(relPath);
  const afterSvg = path.join(outputDir, `after/${safe}.svg`);
  const afterPng = path.join(outputDir, `after/${safe}.png`);
  const beforeSvg = path.join(outputDir, `before/${safe}.svg`);
  const beforePng = path.join(outputDir, `before/${safe}.png`);

  // --- Resolve refs (git-diff-like semantics) ---
  // Default: from=HEAD, to=working tree
  const fromRef = opts.fromRef ?? "HEAD";
  const toRef = opts.toRef ?? "";
  const isWorkingTree = (ref: string) => ref === "" || ref === "working";

  /** Render one side. If `ref` is working tree, render filePath directly.
   *  Otherwise extract from git into a temp file and render that. */
  function renderSide(
    ref: string,
    side: "before" | "after",
    targetSvg: string,
    targetPng: string,
  ): boolean {
    const layersDir = path.join(outputDir, `${side}/layers_${safe}`);
    if (isWorkingTree(ref)) {
      if (fileType === "pcb") {
        renderPcbCombined(filePath, targetSvg);
        renderPcbLayers(filePath, layersDir);
      } else {
        renderSch(filePath, path.join(outputDir, side), targetSvg);
      }
      svgToPng(targetSvg, targetPng);
      return fs.existsSync(targetPng);
    }
    if (!repoRoot || !gitHasFileAtRef(repoRoot, ref, relPath)) return false;
    let tempFile: string | null = null;
    try {
      tempFile = makeTempBeside(filePath);
      gitShowToFile(repoRoot, ref, relPath, tempFile);
      if (fileType === "pcb") {
        renderPcbCombined(tempFile, targetSvg);
        renderPcbLayers(tempFile, layersDir);
      } else {
        renderSch(tempFile, path.join(outputDir, side), targetSvg);
      }
      svgToPng(targetSvg, targetPng);
      return fs.existsSync(targetPng);
    } finally {
      if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // --- Render after (target) ---
  const afterOk = renderSide(toRef, "after", afterSvg, afterPng);
  if (!afterOk) throw new Error(`failed to render after side (ref="${toRef}")`);

  // --- Render before (base) ---
  const hasBefore = renderSide(fromRef, "before", beforeSvg, beforePng);

  // --- Diff highlight (optional, requires ImageMagick) ---
  let diffPng: string | undefined;
  if (hasBefore && hasCommand("magick")) {
    const diffDir = path.join(outputDir, "diff");
    fs.mkdirSync(diffDir, { recursive: true });
    diffPng = path.join(diffDir, `${safe}.png`);
    tryRun("magick", [
      "compare", "-fuzz", "5%",
      "-highlight-color", "#ff000088",
      "-lowlight-color", "transparent",
      "-compose", "src",
      beforePng, afterPng, diffPng,
    ]);
    if (!fs.existsSync(diffPng)) diffPng = undefined;
  }

  const manifest = buildManifest({
    relPath, fileType, outputDir, safe, hasBefore, diffPng,
  });

  const result: RenderResult = {
    filePath, relPath, fileType, outputDir, afterPng,
    beforePng: hasBefore ? beforePng : undefined,
    diffPng,
    manifest,
  };

  // --images-only: skip HTML generation
  if (opts.imagesOnly) return result;

  // --- HTML generation ---
  const viewerPath = path.resolve(__dirname, "..", "viewer.html");
  const html = buildHtml(viewerPath, manifest);
  const diffHtml = path.join(outputDir, `${safe}_diff.html`);
  fs.writeFileSync(diffHtml, html);
  result.diffHtml = diffHtml;

  // --- Auto-open the diff HTML (non-blocking) ---
  if (opts.open !== undefined) {
    openInEditor(diffHtml, opts.open);
  }

  return result;
}

/** Map well-known short names to their actual command + flags.
 *  Anything not in this map is treated as a literal executable name. */
const OPEN_ALIASES: Record<string, [string, string[]]> = {
  xdg: ["xdg-open", []],
  vscode: ["code", ["-r"]],
  code: ["code", ["-r"]],
};

/** Spawn an external command to open the diff HTML.
 *  Honors KICADIFF_OPEN_CMD env var for testing/customization.
 *  Returns silently if the command isn't available. */
function openInEditor(htmlPath: string, target: string): void {
  // Env var takes precedence — useful for testing and custom configurations
  const overrideCmd = process.env.KICADIFF_OPEN_CMD;
  let cmd: string;
  let args: string[];
  if (overrideCmd !== undefined) {
    if (overrideCmd === "") return; // explicit no-op
    const parts = overrideCmd.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;
    cmd = parts[0];
    args = [...parts.slice(1), htmlPath];
  } else {
    const alias = OPEN_ALIASES[target];
    if (alias) {
      [cmd, args] = [alias[0], [...alias[1], htmlPath]];
    } else {
      // Unknown target — treat as a literal executable name (firefox, chromium, etc.)
      cmd = target;
      args = [htmlPath];
    }
  }
  if (!hasCommand(cmd)) {
    console.error(`Warning: open command not found: ${cmd}`);
    return;
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

/** Print a human-readable summary, used by the CLI / Claude Code hook. */
export function printSummary(r: RenderResult, imagesOnly: boolean): void {
  if (imagesOnly) {
    console.log(`Images updated: ${r.outputDir}`);
    console.log(`  After:  ${r.afterPng}`);
    if (r.beforePng) console.log(`  Before: ${r.beforePng}`);
    if (r.diffPng) console.log(`  Diff:   ${r.diffPng}`);
    return;
  }
  console.log(`KiCad preview rendered: ${r.relPath}`);
  console.log(`  After:  ${r.afterPng}`);
  if (r.beforePng) {
    console.log(`  Before: ${r.beforePng}`);
    console.log("");
    console.log("Read both PNG files to visually compare the before/after state of your edit.");
    if (r.diffHtml) console.log(`Diff HTML: ${r.diffHtml} (open with Live Preview in VSCode)`);
  } else {
    console.log("  (New file — no before state in git)");
    console.log("");
    console.log("Read the PNG file to verify the visual result of your edit.");
  }
}

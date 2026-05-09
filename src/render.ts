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
import VIEWER_HTML from "./viewer-content.ts";
import type { FileType, FileManifest, Manifest, ProjectManifest, SideManifest } from "./types.ts";

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

/** Run a command async, throwing on non-zero exit. stderr is inherited so
 *  diagnostics surface. Suitable for Promise.all parallelization. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${args.join(" ")}`));
    });
  });
}

/** Run a command async, ignoring failures (used for optional tools). */
function tryRun(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  });
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

async function renderPcbCombined(input: string, outputSvg: string): Promise<void> {
  await run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-single",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", outputSvg,
    input,
  ]);
}

async function renderPcbLayers(input: string, outputDir: string): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  await run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-multi",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", `${outputDir}/`,
    input,
  ]);
  // Convert each generated SVG to PNG in parallel (preserves alpha)
  const conversions = fs.readdirSync(outputDir)
    .filter(f => f.endsWith(".svg"))
    .map(f => {
      const svg = path.join(outputDir, f);
      const png = svg.replace(/\.svg$/, ".png");
      return run("rsvg-convert", ["-w", "1600", svg, "-o", png]);
    });
  await Promise.all(conversions);
}

async function renderSch(input: string, outputDir: string, outputSvg: string): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  await run("kicad-cli", [
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

async function svgToPng(svg: string, png: string): Promise<void> {
  if (fs.existsSync(svg)) {
    await run("rsvg-convert", ["-w", "1600", svg, "-o", png]);
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
/** Returns the viewer.html content, embedded at build-time as a TS string
 *  (see scripts/embed-viewer.mjs). Bundling this way lets bun --compile
 *  produce a fully self-contained binary with no external assets. */
function readViewerHtml(): string {
  return VIEWER_HTML;
}

function buildHtml(_viewerPath: string, manifest: Manifest): string {
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  return `<script>window.MANIFEST = ${json};</script>\n${readViewerHtml()}`;
}

// =============================================================================
// Main entry
// =============================================================================

export async function render(opts: RenderOptions): Promise<RenderResult> {
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
   *  Otherwise extract from git into a temp file and render that.
   *  For PCB, the combined and per-layer kicad-cli calls run in parallel. */
  async function renderSide(
    ref: string,
    side: "before" | "after",
    targetSvg: string,
    targetPng: string,
  ): Promise<boolean> {
    const layersDir = path.join(outputDir, `${side}/layers_${safe}`);

    async function renderFromSource(src: string): Promise<void> {
      if (fileType === "pcb") {
        // Combined and layered exports are independent → run in parallel
        await Promise.all([
          renderPcbCombined(src, targetSvg),
          renderPcbLayers(src, layersDir),
        ]);
      } else {
        await renderSch(src, path.join(outputDir, side), targetSvg);
      }
      await svgToPng(targetSvg, targetPng);
    }

    if (isWorkingTree(ref)) {
      await renderFromSource(filePath);
      return fs.existsSync(targetPng);
    }
    if (!repoRoot || !gitHasFileAtRef(repoRoot, ref, relPath)) return false;
    let tempFile: string | null = null;
    try {
      tempFile = makeTempBeside(filePath);
      gitShowToFile(repoRoot, ref, relPath, tempFile);
      await renderFromSource(tempFile);
      return fs.existsSync(targetPng);
    } finally {
      if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // --- Render after (target) and before (base) in parallel ---
  // Each side runs combined||layers internally for further speedup.
  const [afterOk, hasBefore] = await Promise.all([
    renderSide(toRef, "after", afterSvg, afterPng),
    renderSide(fromRef, "before", beforeSvg, beforePng),
  ]);
  if (!afterOk) throw new Error(`failed to render after side (ref="${toRef}")`);

  // --- Diff highlight (optional, requires ImageMagick) ---
  let diffPng: string | undefined;
  if (hasBefore && hasCommand("magick")) {
    const diffDir = path.join(outputDir, "diff");
    fs.mkdirSync(diffDir, { recursive: true });
    diffPng = path.join(diffDir, `${safe}.png`);
    await tryRun("magick", [
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

// =============================================================================
// Project-level rendering (combined PCB + schematic)
// =============================================================================

export interface ProjectRenderOptions {
  /** Input: directory, .kicad_pro, .kicad_pcb, .kicad_sch, or undefined (=cwd).
   *  When a directory or .kicad_pro is given, both .kicad_pcb and .kicad_sch
   *  siblings are picked up. When a single .kicad_{pcb,sch} is given, the
   *  matching sibling of the other type is also included if it exists. */
  input?: string;
  outputDir?: string;
  fromRef?: string;
  toRef?: string;
  imagesOnly?: boolean;
  open?: string;
  /** Force single-file mode (set by `pcb`/`sch` subcommand). When set, only
   *  the file matching the scope is rendered, no sibling auto-detection. */
  scope?: FileType;
}

export interface ProjectRenderResult {
  results: RenderResult[];
  /** Path to the combined HTML (only present when more than one file rendered
   *  AND imagesOnly is false). For single-file mode, the per-file HTML in
   *  the corresponding RenderResult.diffHtml is the entry point. */
  combinedHtml?: string;
}

/** Resolve the user's input into a list of KiCad files to render.
 *  See ProjectRenderOptions.input for accepted formats. */
export function resolveInputs(
  rawInput: string | undefined,
  scope: FileType | undefined,
): string[] {
  const input = rawInput ?? process.cwd();
  const abs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);

  if (!fs.existsSync(abs)) {
    throw new Error(`input not found: ${abs}`);
  }

  const stat = fs.statSync(abs);
  let pcb: string | undefined;
  let sch: string | undefined;

  if (stat.isDirectory()) {
    // Pick the first .kicad_pcb / .kicad_sch in the directory
    for (const f of fs.readdirSync(abs).sort()) {
      const fp = path.join(abs, f);
      if (!pcb && f.endsWith(".kicad_pcb")) pcb = fp;
      if (!sch && f.endsWith(".kicad_sch")) sch = fp;
    }
  } else if (abs.endsWith(".kicad_pro")) {
    // Find siblings with the same basename
    const dir = path.dirname(abs);
    const base = path.basename(abs, ".kicad_pro");
    const pcbCandidate = path.join(dir, `${base}.kicad_pcb`);
    const schCandidate = path.join(dir, `${base}.kicad_sch`);
    if (fs.existsSync(pcbCandidate)) pcb = pcbCandidate;
    if (fs.existsSync(schCandidate)) sch = schCandidate;
  } else if (abs.endsWith(".kicad_pcb")) {
    pcb = abs;
    const schCandidate = abs.slice(0, -".kicad_pcb".length) + ".kicad_sch";
    if (scope === undefined && fs.existsSync(schCandidate)) sch = schCandidate;
  } else if (abs.endsWith(".kicad_sch")) {
    sch = abs;
    const pcbCandidate = abs.slice(0, -".kicad_sch".length) + ".kicad_pcb";
    if (scope === undefined && fs.existsSync(pcbCandidate)) pcb = pcbCandidate;
  } else {
    throw new Error(`unsupported input: ${abs} (expected dir, .kicad_pro, .kicad_pcb, or .kicad_sch)`);
  }

  // Apply scope filter (subcommand)
  if (scope === "pcb") sch = undefined;
  if (scope === "sch") pcb = undefined;

  const result: string[] = [];
  if (pcb) result.push(pcb);
  if (sch) result.push(sch);
  if (result.length === 0) {
    throw new Error(`no KiCad files found under: ${abs}`);
  }
  return result;
}

/** Render one or more KiCad files and produce a single combined HTML viewer.
 *  Used as the main entry point — the CLI and Claude Code hook call this.
 *  Multiple input files are rendered in parallel (PCB and SCH have no
 *  shared state). Within each file, before|after and combined|layers also
 *  run in parallel — see render(). */
export async function renderProject(opts: ProjectRenderOptions): Promise<ProjectRenderResult> {
  const files = resolveInputs(opts.input, opts.scope);
  const results: RenderResult[] = await Promise.all(
    files.map(file =>
      render({
        filePath: file,
        outputDir: opts.outputDir,
        fromRef: opts.fromRef,
        toRef: opts.toRef,
        imagesOnly: true, // we'll generate one combined HTML below
      }),
    ),
  );

  if (opts.imagesOnly) {
    return { results };
  }

  // Build a combined manifest and HTML in the shared output directory
  const outDir = results[0].outputDir;
  const manifest: ProjectManifest = { files: results.map(r => r.manifest) };
  const safeName = projectSafeName(files);
  const combinedHtml = path.join(outDir, `${safeName}_diff.html`);
  fs.writeFileSync(combinedHtml, buildHtmlFromProject(manifest));

  // Auto-open if requested
  if (opts.open !== undefined) {
    openInEditor(combinedHtml, opts.open);
  }

  // Annotate each result with the combined HTML for CLI display
  for (const r of results) r.diffHtml = combinedHtml;

  return { results, combinedHtml };
}

/** Derive a stable filename for the combined HTML based on the input files. */
function projectSafeName(files: string[]): string {
  // Use the common basename if all files share one (typical for KiCad projects)
  const bases = files.map(f => {
    const name = path.basename(f);
    return name.replace(/\.kicad_(pcb|sch)$/, "");
  });
  const allSame = bases.every(b => b === bases[0]);
  if (allSame) return bases[0].replace(/[^a-zA-Z0-9._-]/g, "_");
  // Otherwise concatenate
  return bases.map(b => b.replace(/[^a-zA-Z0-9._-]/g, "_")).join("__");
}

function buildHtmlFromProject(manifest: ProjectManifest): string {
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  return `<script>window.MANIFEST = ${json};</script>\n${readViewerHtml()}`;
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

#!/usr/bin/env bun
/**
 * kicadiff CLI entry point.
 *
 * Usage (git diff-compatible):
 *   kicadiff                                 cwd as input (combined PCB+sch)
 *   kicadiff <input>                         <input> = file/dir/.kicad_pro
 *   kicadiff <ref> <input>                   Compare working tree vs <ref>
 *   kicadiff <r1> <r2> <input>               Compare <r1> vs <r2>
 *   kicadiff <r1>..<r2> <input>              Same as above (range syntax)
 *   kicadiff <ref> -- <input>                Explicit `--` separator
 *   kicadiff pcb|sch <file>                  Subcommand (single-file scoped)
 *   kicadiff hook                            Read PostToolUse JSON from stdin
 *                                            and render if a KiCad file was
 *                                            edited (Claude Code integration).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderProject, printProjectSummary, resolveInputs, resolveOutputPath } from "./render.ts";
import type { LogLevel, ProjectRenderResult } from "./render.ts";
import { textDiff, markdownDiff } from "./textdiff.ts";
import type { FileType } from "./types.ts";

function usage(): void {
  console.log(`kicadiff — Visual diff for KiCad files

Usage:
  kicadiff [<refs>] [<input>]              Combined PCB + schematic diff
  kicadiff <subcommand> [<refs>] <file>    Single-type scoped diff

Subcommands:
  pcb        Render only the PCB diff (.kicad_pcb file required)
  sch        Render only the schematic diff (.kicad_sch file required)
  schematic  Alias for \`sch\`
  sym        Render only the symbol library diff (.kicad_sym file required)
  symbol     Alias for \`sym\`
  fp         Render footprint diff (.kicad_mod file or .pretty/ directory)
  footprint  Alias for \`fp\`
  hook       Claude Code PostToolUse adapter: read the hook JSON from stdin,
             render only when the edited file is .kicad_pcb / .kicad_sch.
             Defaults to \`--open vscode\`; pass \`--open ...\` to override.

Inputs (positional):
  <input>    One of:
               - <file.kicad_pcb> / <file.kicad_sch>  (single file; sibling of
                 the other type is auto-included unless a subcommand scopes it)
               - <file.kicad_sym> / <file.kicad_mod>  (single library / footprint)
               - <dir.pretty>                          (footprint library directory)
               - <file.kicad_pro>                      (KiCad project file)
               - <directory>                           (find all files in dir)
               - (omitted)                             (current working dir)

Refs (positional, git diff-compatible):
  <ref>             Compare working tree vs <ref>            (1 ref)
  <r1> <r2>         Compare <r1> vs <r2>                     (2 refs)
  <r1>..<r2>        Same as above (range syntax)             (1 ref token)
  --                Separator: refs before, input after

Options:
  --from <ref>           Base ref (alternative to positional)
  --to <ref>             Target ref (alternative to positional; default: working tree)
  --output-dir <dir>     Image output directory (default: <repo>/.claude/preview)
  -o, --output <path>    Output file path. Default: <output-dir>/<name>_diff.html
                         (or .md with --markdown). Image paths in the file are
                         emitted relative to <path>'s directory so the file is
                         portable. Use \`--output -\` or \`--output stdout\` to
                         write the markdown report to stdout instead of a file.
  --images-only          Skip HTML generation and auto-open
  --text                 Also print a structural text diff to stdout
  --text-only            Print only the text diff (no SVG/PNG/HTML rendering — fast)
  --markdown, --md       Render images and emit a markdown report (side-by-side
                         image table + structural diff). Skips HTML viewer.
  -v, --verbose, --debug Show every PNG path in the summary (default: only HTML path)
  -q, --quiet            Suppress the summary entirely
  --log <level>          Set summary log level: quiet | info | debug (default: info)
  --no-cache             Skip the render cache (default: cached at \$XDG_CACHE_HOME/kicadiff)
  --open                 Open diff HTML with xdg-open after rendering
  --open vscode|code     Open in VSCode tab (\`code -r\`)
  --open firefox|...     Open in named browser (firefox, chromium, chrome, etc.)
  --open=<cmd>           Use arbitrary command (\`<cmd> <html-path>\`)
  -h, --help             Show this help

Env:
  KICADIFF_OPEN_CMD      Override --open command (full command, html path
                         appended; empty string = no-op). Useful for testing.

Examples:
  kicadiff                              # cwd, combined PCB+sch vs HEAD
  kicadiff project/                     # both files in project/
  kicadiff foo.kicad_pcb                # foo.kicad_pcb + sibling foo.kicad_sch
  kicadiff main project/                # working tree vs main
  kicadiff main..feat foo.kicad_pcb     # main vs feat
  kicadiff pcb foo.kicad_pcb            # PCB only (no auto-include)
  kicadiff schematic foo.kicad_sch      # schematic only
  kicadiff v1.0 v2.0 -- board.kicad_pcb # explicit -- separator
`);
}

interface ParsedArgs {
  /** Resolved input — file path, directory, .kicad_pro, or undefined (=cwd) */
  input?: string;
  fromRef?: string;
  toRef?: string;
  outputDir?: string;
  /** Explicit path for the combined diff HTML file. When set, manifest image
   *  paths are emitted relative to the HTML's directory. */
  outputHtml?: string;
  imagesOnly?: boolean;
  /** Print structural text diff to stdout. Cheap (no SVG/PNG rendering).
   *  When also producing HTML/images, the text appears alongside. */
  text?: boolean;
  /** Skip HTML/image rendering — only print the text diff. */
  textOnly?: boolean;
  /** Markdown mode: emit a markdown report referencing rendered images
   *  (side-by-side, structural diff for pcb/sch). Images are rendered;
   *  HTML viewer generation is skipped (markdown is the deliverable). */
  markdown?: boolean;
  /** Log level for stdout summary. Default "info". "debug" surfaces every PNG
   *  path; "quiet" suppresses the summary entirely. */
  logLevel?: LogLevel;
  /** Disable the per-side render cache (default: cache enabled). */
  noCache?: boolean;
  scope?: FileType;
  open?: string;
}

/** Known names that can be used after a bare `--open` (with a space).
 *  Anything else needs `--open=<value>` to disambiguate from positional args. */
const KNOWN_OPEN_TARGETS = new Set([
  "xdg",
  "vscode", "code",
  "firefox", "chromium", "chrome", "brave", "edge", "safari",
]);

/** True if `s` looks like a kicadiff input (kicad file, .kicad_pro, or
 *  an existing directory). Used to disambiguate input from refs.
 *
 *  The slash-containing case is tricky: branch names commonly contain
 *  slashes (`feature/foo`, `release/v1`), so we can't treat any slash as
 *  "this is a path". Heuristic:
 *    - explicit relative/absolute paths (`./x`, `../x`, `/x`, ends with `/`)
 *    - paths that exist on disk
 *  Anything else → falls through to ref handling, where `git rev-parse`
 *  validates the name and reports a useful error if it isn't a ref either. */
function isLikelyInput(s: string): boolean {
  if (
    s.endsWith(".kicad_pcb") ||
    s.endsWith(".kicad_sch") ||
    s.endsWith(".kicad_pro") ||
    s.endsWith(".kicad_sym") ||
    s.endsWith(".kicad_mod") ||
    s.endsWith(".pretty") ||
    s.endsWith(".pretty/")
  ) {
    return true;
  }
  if (s === "." || s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.endsWith("/")) {
    return true;
  }
  // A bare slash-containing token might be a path or a branch name; only
  // treat as input if it actually exists on disk. Existence wins over the
  // ref name if both happen to coincide — explicit `--` separator can
  // disambiguate that edge case.
  if (s.includes("/")) {
    try { return fs.existsSync(s); } catch { /* fall through */ }
  }
  return false;
}

/** Validate a string is a usable git ref. */
function isLikelyValidRef(ref: string): boolean {
  if (ref === "" || ref === "working") return true;
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref + "^{}"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  let i = 0;
  let scope: FileType | undefined;

  // Detect leading subcommand. Aliases:
  //   sch ↔ schematic
  //   sym ↔ symbol
  //   fp  ↔ footprint
  if (argv[0] === "pcb") {
    scope = "pcb";
    i = 1;
  } else if (argv[0] === "sch" || argv[0] === "schematic") {
    scope = "sch";
    i = 1;
  } else if (argv[0] === "sym" || argv[0] === "symbol") {
    scope = "sym";
    i = 1;
  } else if (argv[0] === "fp" || argv[0] === "footprint") {
    scope = "fp";
    i = 1;
  }

  const positional: string[] = [];
  const inputsAfterDash: string[] = [];
  let sawDoubleDash = false;
  let fromRef: string | undefined;
  let toRef: string | undefined;
  let outputDir: string | undefined;
  let outputHtml: string | undefined;
  let imagesOnly = false;
  let text = false;
  let textOnly = false;
  let markdown = false;
  let logLevel: LogLevel | undefined;
  let noCache = false;
  let open: string | undefined;

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (sawDoubleDash) {
      inputsAfterDash.push(arg);
      continue;
    }
    if (arg === "--") {
      sawDoubleDash = true;
    } else if (arg === "--from") {
      if (i + 1 >= argv.length) throw new Error("--from requires a value");
      fromRef = argv[++i];
    } else if (arg === "--to") {
      if (i + 1 >= argv.length) throw new Error("--to requires a value");
      toRef = argv[++i];
    } else if (arg === "--output-dir") {
      if (i + 1 >= argv.length) throw new Error("--output-dir requires a value");
      outputDir = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      outputHtml = argv[++i];
    } else if (arg.startsWith("--output=")) {
      outputHtml = arg.slice("--output=".length);
    } else if (arg === "--images-only") {
      imagesOnly = true;
    } else if (arg === "--text") {
      text = true;
    } else if (arg === "--text-only") {
      textOnly = true;
      text = true;
    } else if (arg === "--markdown" || arg === "--md") {
      markdown = true;
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--verbose" || arg === "-v" || arg === "--debug") {
      logLevel = "debug";
    } else if (arg === "--quiet" || arg === "-q") {
      logLevel = "quiet";
    } else if (arg === "--log") {
      if (i + 1 >= argv.length) throw new Error("--log requires a value");
      const v = argv[++i];
      if (v !== "quiet" && v !== "info" && v !== "debug") {
        throw new Error(`invalid --log level: ${v} (expected quiet, info, or debug)`);
      }
      logLevel = v;
    } else if (arg === "--open" || arg.startsWith("--open=")) {
      let target: string | undefined;
      if (arg.startsWith("--open=")) {
        target = arg.slice("--open=".length);
      } else if (i + 1 < argv.length && KNOWN_OPEN_TARGETS.has(argv[i + 1])) {
        target = argv[++i];
      }
      open = target ?? "xdg";
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  // Determine which positional is the input, which are refs.
  // - With `--`: everything after `--` is input(s); pre-`--` is refs.
  // - Otherwise: the LAST positional that looks like an input (file/dir/pro)
  //   is treated as input; earlier positionals are refs.
  // - If no positional looks like an input, all are refs and input = undefined (cwd).
  let input: string | undefined;
  let refTokens: string[];
  if (sawDoubleDash) {
    if (inputsAfterDash.length > 1) {
      throw new Error(`expected at most 1 input after \`--\`, got ${inputsAfterDash.length}`);
    }
    input = inputsAfterDash[0];
    refTokens = positional;
  } else {
    let inputIdx = -1;
    for (let j = positional.length - 1; j >= 0; j--) {
      if (isLikelyInput(positional[j])) { inputIdx = j; break; }
    }
    if (inputIdx === -1) {
      // No path-like positional — all are refs, input = cwd
      input = undefined;
      refTokens = positional;
    } else {
      if (positional.slice(inputIdx + 1).length > 0) {
        throw new Error(`extra arguments after input: ${positional.slice(inputIdx + 1).join(" ")}`);
      }
      input = positional[inputIdx];
      refTokens = positional.slice(0, inputIdx);
    }
  }

  // Expand `<r1>..<r2>` range
  const expandedRefs: string[] = [];
  for (const tok of refTokens) {
    const dotIdx = tok.indexOf("..");
    if (dotIdx > 0 && dotIdx < tok.length - 2) {
      expandedRefs.push(tok.slice(0, dotIdx), tok.slice(dotIdx + 2));
    } else {
      expandedRefs.push(tok);
    }
  }

  // Map positional refs to from/to
  if (expandedRefs.length === 0) {
    // Defaults: from=HEAD, to=working
  } else if (expandedRefs.length === 1) {
    if (fromRef === undefined) fromRef = expandedRefs[0];
  } else if (expandedRefs.length === 2) {
    if (fromRef === undefined) fromRef = expandedRefs[0];
    if (toRef === undefined) toRef = expandedRefs[1];
  } else {
    throw new Error(
      `too many ref arguments (max 2, got ${expandedRefs.length}): ${expandedRefs.join(" ")}`,
    );
  }

  if (fromRef !== undefined && !isLikelyValidRef(fromRef)) {
    throw new Error(`bad ref: ${fromRef}`);
  }
  if (toRef !== undefined && !isLikelyValidRef(toRef)) {
    throw new Error(`bad ref: ${toRef}`);
  }

  // Validate subcommand vs input extension when input is a single file.
  // Directory and .kicad_pro inputs skip this check (resolveInputs handles
  // scope-filtering). For sym/fp the file may also be a .pretty directory,
  // so we don't enforce strictly here either.
  if (input !== undefined) {
    if (scope === "pcb" && !input.endsWith(".kicad_pcb")) {
      throw new Error(`pcb subcommand requires a .kicad_pcb file, got: ${input}`);
    }
    if (scope === "sch" && !input.endsWith(".kicad_sch")) {
      throw new Error(`sch subcommand requires a .kicad_sch file, got: ${input}`);
    }
    if (scope === "sym" && !input.endsWith(".kicad_sym")) {
      throw new Error(`sym subcommand requires a .kicad_sym file, got: ${input}`);
    }
    if (scope === "fp" && !input.endsWith(".kicad_mod") && !input.endsWith(".pretty") && !input.endsWith(".pretty/")) {
      throw new Error(`fp subcommand requires a .kicad_mod file or .pretty directory, got: ${input}`);
    }
  }

  return {
    input, fromRef, toRef, outputDir, outputHtml, imagesOnly, text, textOnly,
    markdown, logLevel, noCache, scope, open,
  };
}

/** Read all of stdin synchronously. Used by the `hook` subcommand to consume
 *  the PostToolUse JSON Claude Code pipes in. We deliberately use the
 *  fd-based `readFileSync(0, ...)` form: it's available on every runtime
 *  (Node, Bun) and avoids the async/streaming dance that `process.stdin`
 *  would otherwise require for what is essentially a one-shot read. */
function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Translate a Claude Code PostToolUse hook invocation into normal kicadiff
 *  arguments. Returns the synthesized argv to feed into parseArgs, or `null`
 *  if the hook should be a no-op (the edited file isn't a KiCad file, or
 *  doesn't exist). The shape of the input is documented at:
 *  https://docs.anthropic.com/en/docs/claude-code/hooks#hook-input
 *
 *  Default behavior mirrors the previous shell wrapper: render with
 *  `--open vscode` so the diff opens automatically in a Live Preview tab.
 *  Anything the caller already passed (e.g. `--open firefox`) wins. */
function expandHookArgs(restArgs: string[]): string[] | null {
  const stdin = readStdinSync();
  let data: { tool_input?: { file_path?: string } };
  try {
    data = JSON.parse(stdin);
  } catch (e) {
    console.error(`kicadiff hook: invalid JSON on stdin: ${(e as Error).message}`);
    process.exit(1);
  }
  const filePath = data?.tool_input?.file_path ?? "";
  // Quietly skip non-KiCad edits — the hook fires on every Edit/Write, so
  // it must be cheap and silent for the common case.
  if (!filePath) return null;
  if (!filePath.endsWith(".kicad_pcb") && !filePath.endsWith(".kicad_sch")) {
    return null;
  }
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  // The path may be reported for a delete or for a write that hasn't flushed
  // yet — either way, no file = nothing to diff.
  if (!fs.existsSync(abs)) return null;

  const hasOpen = restArgs.some(a => a === "--open" || a.startsWith("--open="));
  const out = [...restArgs];
  if (!hasOpen) out.push("--open", "vscode");
  out.push(abs);
  return out;
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    usage();
    process.exit(0);
  }

  if (argv[0] === "hook") {
    if (argv[1] === "-h" || argv[1] === "--help") {
      usage();
      process.exit(0);
    }
    const expanded = expandHookArgs(argv.slice(1));
    if (expanded === null) process.exit(0);
    argv = expanded;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    usage();
    process.exit(1);
  }

  try {
    // --text-only short-circuits rendering entirely — useful when piping the
    // structural diff into another tool without paying for SVG/PNG.
    if (parsed.textOnly) { printTextDiff(parsed); return; }

    // --markdown skips HTML viewer generation: the markdown is the deliverable
    // and the viewer would be redundant. Images still render so the markdown
    // can reference them.
    const skipHtml = parsed.imagesOnly || parsed.markdown;

    const project = await renderProject({
      input: parsed.input,
      outputDir: parsed.outputDir,
      outputHtml: parsed.outputHtml,
      imagesOnly: skipHtml,
      fromRef: parsed.fromRef,
      toRef: parsed.toRef,
      open: parsed.open,
      scope: parsed.scope,
      noCache: parsed.noCache,
    });
    // When stdout is reserved for the markdown report (--md --output stdout/-),
    // route the summary line to stderr so the user can pipe `> report.md`
    // without polluting the file with progress chatter.
    const stdoutIsReport = parsed.markdown
      && (parsed.outputHtml === "-" || parsed.outputHtml === "stdout");
    printProjectSummary(project, !!skipHtml, parsed.logLevel ?? "info", stdoutIsReport);
    const quiet = (parsed.logLevel ?? "info") === "quiet";
    const newline = (s: string) => stdoutIsReport ? process.stderr.write(s + "\n") : console.log(s);
    if (parsed.text) {
      if (!quiet) newline("");
      // When stdout is reserved for the markdown report, route the text
      // diff to stderr too so it doesn't get prepended to the .md file.
      printTextDiff(parsed, stdoutIsReport ? "stderr" : "stdout");
    }
    if (parsed.markdown) {
      if (!quiet && !stdoutIsReport) newline("");
      emitMarkdownReport(parsed, project);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** Resolve inputs and emit a structural text diff for each file. By default
 *  goes to stdout; pass "stderr" to redirect (used when stdout is reserved
 *  for a markdown report being piped into a file). Skips file types that
 *  the text differ doesn't support (sym/fp). */
function printTextDiff(parsed: ParsedArgs, dest: "stdout" | "stderr" = "stdout"): void {
  const files = resolveInputs(parsed.input, parsed.scope)
    .filter(f => f.endsWith(".kicad_pcb") || f.endsWith(".kicad_sch"));
  if (files.length === 0) {
    console.error("Warning: text diff supports only .kicad_pcb / .kicad_sch — nothing to diff");
    return;
  }
  const fromRef = parsed.fromRef ?? "HEAD";
  const toRef = parsed.toRef ?? "";
  const repoRoot = repoRootOf(files[0]);
  const out = dest === "stderr"
    ? (s: string) => process.stderr.write(s + "\n")
    : (s: string) => console.log(s);
  for (const f of files) {
    out(textDiff(f, fromRef, toRef, repoRoot));
  }
}

/** Format a friendly ref label for markdown headings. Mirrors the viewer's
 *  refLabel: empty/missing toRef → "working tree", full SHAs → 7-char short. */
function refLabelMd(ref: string): string {
  if (!ref) return "working tree";
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  return ref;
}

/** Build the markdown report text. Image paths are emitted relative to
 *  `mdDir` so the file is portable: ship the .md alongside its image
 *  directory and links resolve from any location. */
function buildMarkdownReport(
  parsed: ParsedArgs,
  project: ProjectRenderResult,
  mdDir: string,
): string {
  const fromRef = parsed.fromRef ?? "HEAD";
  const toRef = parsed.toRef ?? "";
  const fromLabel = refLabelMd(fromRef);
  const toLabel = refLabelMd(toRef);
  const repoRoot = project.results[0]
    ? repoRootOf(project.results[0].filePath)
    : null;

  const sections: string[] = [];
  for (const r of project.results) {
    const m = r.manifest;
    const lines: string[] = [];
    const rel = (abs: string) => path.relative(mdDir, abs);

    // 1. Heading
    lines.push(`## \`${r.relPath}\` (${m.type})`);

    // 2. Image(s). Three shapes depending on which sides rendered:
    //    - both sides: side-by-side image table (the typical diff view)
    //    - after only: a "new file" preview
    //    - before only: a "deleted in <toRef>" preview, so the reviewer
    //      still sees the visual context for the deletion
    if (m.hasBefore && r.beforePng && r.afterPng) {
      lines.push("");
      lines.push(`| Before (${fromLabel}) | After (${toLabel}) |`);
      lines.push("| --- | --- |");
      lines.push(`| ![Before](${rel(r.beforePng)}) | ![After](${rel(r.afterPng)}) |`);
    } else if (r.afterPng) {
      lines.push("");
      lines.push(`![Preview](${rel(r.afterPng)})`);
    } else if (r.beforePng) {
      lines.push("");
      lines.push(`![Before — deleted in ${toLabel}](${rel(r.beforePng)})`);
    }

    // 3. Structural diff body (pcb/sch only). markdownDiff produces its own
    //    heading; drop it so our heading above isn't duplicated.
    if (m.type === "pcb" || m.type === "sch") {
      const struct = markdownDiff(r.filePath, fromRef, toRef, repoRoot)
        .split("\n");
      if (struct[0]?.startsWith("##")) {
        struct.shift();
        while (struct.length > 0 && struct[0] === "") struct.shift();
      }
      lines.push("");
      lines.push(...struct);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n") + "\n";
}

/** Project-level filename for the combined markdown — kept in sync with the
 *  HTML's projectSafeName so users get matching `<name>_diff.html` and
 *  `<name>_diff.md` siblings. */
function projectSafeNameFromResults(project: ProjectRenderResult): string {
  if (project.combinedHtml) {
    return path.basename(project.combinedHtml).replace(/_diff\.html$/, "");
  }
  // Fallback when imagesOnly skipped HTML: derive from the first file
  const first = project.results[0];
  if (!first) return "diff";
  return path.basename(first.filePath).replace(/\.kicad_(pcb|sch|sym|mod)$/, "");
}

/** Emit the markdown report. Default destination is a file alongside the
 *  rendered images (parallel to the HTML viewer); `--output - / stdout`
 *  redirects to standard output, with image paths relative to CWD so the
 *  user can pipe / redirect somewhere predictable. */
function emitMarkdownReport(parsed: ParsedArgs, project: ProjectRenderResult): void {
  const outArg = parsed.outputHtml; // unified --output / -o flag
  const isStdout = outArg === "-" || outArg === "stdout";

  if (isStdout) {
    process.stdout.write(buildMarkdownReport(parsed, project, process.cwd()));
    return;
  }

  const outDir = project.results[0]?.outputDir ?? process.cwd();
  const safeName = projectSafeNameFromResults(project);
  const mdPath = outArg
    ? resolveOutputPath(outArg, `${safeName}_diff.md`)
    : path.join(outDir, `${safeName}_diff.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, buildMarkdownReport(parsed, project, path.dirname(mdPath)));
  if ((parsed.logLevel ?? "info") !== "quiet") {
    console.log(`Diff markdown: ${mdPath}`);
  }
}

function repoRootOf(filePath: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: filePath.replace(/\/[^/]*$/, "") || ".",
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

main();

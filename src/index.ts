#!/usr/bin/env node
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
 */

import { spawnSync } from "node:child_process";
import { renderProject, printProjectSummary, resolveInputs } from "./render.ts";
import type { LogLevel } from "./render.ts";
import { textDiff } from "./textdiff.ts";
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
  -o, --output <path>    Diff HTML output path (default: <output-dir>/<name>_diff.html).
                         Image paths in the HTML are made relative to <path>'s dir.
  --images-only          Skip HTML generation and auto-open
  --text                 Also print a structural text diff to stdout
  --text-only            Print only the text diff (no SVG/PNG/HTML rendering — fast)
  -v, --verbose, --debug Show every PNG path in the summary (default: only HTML path)
  -q, --quiet            Suppress the summary entirely
  --log <level>          Set summary log level: quiet | info | debug (default: info)
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
  /** Log level for stdout summary. Default "info". "debug" surfaces every PNG
   *  path; "quiet" suppresses the summary entirely. */
  logLevel?: LogLevel;
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
 *  an existing directory). Used to disambiguate input from refs. */
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
  // Any path containing a slash is treated as a path; avoids false-positives
  // where a ref name happens to be a real directory in cwd.
  if (s.includes("/") || s === ".") return true;
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
  let logLevel: LogLevel | undefined;
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
    input, fromRef, toRef, outputDir, outputHtml, imagesOnly, text, textOnly, logLevel, scope, open,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    usage();
    process.exit(0);
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
    if (parsed.textOnly) {
      printTextDiff(parsed);
      return;
    }
    const project = await renderProject({
      input: parsed.input,
      outputDir: parsed.outputDir,
      outputHtml: parsed.outputHtml,
      imagesOnly: parsed.imagesOnly,
      fromRef: parsed.fromRef,
      toRef: parsed.toRef,
      open: parsed.open,
      scope: parsed.scope,
    });
    printProjectSummary(project, !!parsed.imagesOnly, parsed.logLevel ?? "info");
    if (parsed.text) {
      if ((parsed.logLevel ?? "info") !== "quiet") console.log("");
      printTextDiff(parsed);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** Resolve inputs and emit a structural text diff for each file to stdout.
 *  Skips file types that the text differ doesn't support (sym/fp). */
function printTextDiff(parsed: ParsedArgs): void {
  const files = resolveInputs(parsed.input, parsed.scope)
    .filter(f => f.endsWith(".kicad_pcb") || f.endsWith(".kicad_sch"));
  if (files.length === 0) {
    console.error("Warning: text diff supports only .kicad_pcb / .kicad_sch — nothing to diff");
    return;
  }
  const fromRef = parsed.fromRef ?? "HEAD";
  const toRef = parsed.toRef ?? "";
  const repoRoot = repoRootOf(files[0]);
  for (const f of files) {
    console.log(textDiff(f, fromRef, toRef, repoRoot));
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

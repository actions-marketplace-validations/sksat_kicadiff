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
import { renderProject, printSummary } from "./render.ts";
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

Inputs (positional):
  <input>    One of:
               - <file.kicad_pcb> / <file.kicad_sch>  (single file; sibling of
                 the other type is auto-included unless a subcommand scopes it)
               - <file.kicad_pro>                      (KiCad project file)
               - <directory>                           (find both files in dir)
               - (omitted)                             (current working dir)

Refs (positional, git diff-compatible):
  <ref>             Compare working tree vs <ref>            (1 ref)
  <r1> <r2>         Compare <r1> vs <r2>                     (2 refs)
  <r1>..<r2>        Same as above (range syntax)             (1 ref token)
  --                Separator: refs before, input after

Options:
  --from <ref>           Base ref (alternative to positional)
  --to <ref>             Target ref (alternative to positional; default: working tree)
  --output-dir <dir>     Output directory (default: <repo>/.claude/preview)
  --images-only          Skip HTML generation and auto-open
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
  imagesOnly?: boolean;
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
  if (s.endsWith(".kicad_pcb") || s.endsWith(".kicad_sch") || s.endsWith(".kicad_pro")) {
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

  // Detect leading pcb/sch subcommand (with `schematic` as alias for `sch`)
  if (argv[0] === "pcb") {
    scope = "pcb";
    i = 1;
  } else if (argv[0] === "sch" || argv[0] === "schematic") {
    scope = "sch";
    i = 1;
  }

  const positional: string[] = [];
  const inputsAfterDash: string[] = [];
  let sawDoubleDash = false;
  let fromRef: string | undefined;
  let toRef: string | undefined;
  let outputDir: string | undefined;
  let imagesOnly = false;
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
    } else if (arg === "--images-only") {
      imagesOnly = true;
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

  // Validate subcommand vs input extension when input is a single file
  if (input !== undefined) {
    if (scope === "pcb" && !input.endsWith(".kicad_pcb")) {
      throw new Error(`pcb subcommand requires a .kicad_pcb file, got: ${input}`);
    }
    if (scope === "sch" && !input.endsWith(".kicad_sch")) {
      throw new Error(`sch subcommand requires a .kicad_sch file, got: ${input}`);
    }
  }

  return { input, fromRef, toRef, outputDir, imagesOnly, scope, open };
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
    const project = await renderProject({
      input: parsed.input,
      outputDir: parsed.outputDir,
      imagesOnly: parsed.imagesOnly,
      fromRef: parsed.fromRef,
      toRef: parsed.toRef,
      open: parsed.open,
      scope: parsed.scope,
    });
    for (const r of project.results) {
      printSummary(r, !!parsed.imagesOnly);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();

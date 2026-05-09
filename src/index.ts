#!/usr/bin/env node
/**
 * kicadiff CLI entry point.
 *
 * Usage (git diff-compatible):
 *   kicadiff <file>                          Compare working tree vs HEAD
 *   kicadiff <ref> <file>                    Compare working tree vs <ref>
 *   kicadiff <r1> <r2> <file>                Compare <r1> vs <r2>
 *   kicadiff <r1>..<r2> <file>               Same as above (range syntax)
 *   kicadiff <ref> -- <file>                 Explicit `--` separator
 *   kicadiff pcb|sch <file>                  Subcommand for type validation
 *
 * Options:
 *   --from <ref>            Base ref (alternative to positional)
 *   --to <ref>              Target ref (alternative to positional)
 *   --output-dir <dir>      Output directory (default: <repo>/.claude/preview)
 *   --images-only           Skip HTML generation
 */

import { spawnSync } from "node:child_process";
import { render, printSummary } from "./render.ts";

function usage(): void {
  console.log(`kicadiff — Visual diff for KiCad files

Usage:
  kicadiff <file>                          Compare working tree vs HEAD
  kicadiff <ref> <file>                    Compare working tree vs <ref>
  kicadiff <r1> <r2> <file>                Compare two refs
  kicadiff <r1>..<r2> <file>               Same as above (range syntax)
  kicadiff <ref> -- <file>                 Explicit \`--\` separator
  kicadiff pcb|sch <file>                  Subcommand for type validation

Options:
  --from <ref>           Base ref (alternative to positional)
  --to <ref>             Target ref (alternative to positional)
  --output-dir <dir>     Output directory (default: <repo>/.claude/preview)
  --images-only          Skip HTML generation
  --open                 Open diff HTML with xdg-open after rendering
  --open vscode          Open in VSCode tab (\`code -r\`)
  --open firefox         Open in Firefox (any known browser also works)
  --open=<cmd>           Use arbitrary command (\`<cmd> <html-path>\`)
  -h, --help             Show this help

Env:
  KICADIFF_OPEN_CMD      Override --open command (full command, html path
                         appended; empty string = no-op). Useful for testing.

Examples:
  kicadiff board.kicad_pcb              # working tree vs HEAD
  kicadiff main board.kicad_pcb         # working tree vs main
  kicadiff main..feat board.kicad_pcb   # main vs feat
  kicadiff v1.0 v2.0 -- board.kicad_pcb
`);
}

interface ParsedArgs {
  file: string;
  fromRef?: string;
  toRef?: string;
  outputDir?: string;
  imagesOnly?: boolean;
  expectedType?: "pcb" | "sch";
  open?: string;
}

/** Known names that can be used after a bare `--open` (with a space).
 *  Anything else needs `--open=<value>` to disambiguate from positional args.
 *  This list is for ergonomics — render.ts actually accepts any command name. */
const KNOWN_OPEN_TARGETS = new Set([
  "xdg",
  "vscode", "code",
  "firefox", "chromium", "chrome", "brave", "edge", "safari",
]);

function isKicadFile(s: string): boolean {
  return s.endsWith(".kicad_pcb") || s.endsWith(".kicad_sch");
}

/** Validate a string is a usable git ref (resolvable in any reachable repo).
 *  Accepts `HEAD`, branch/tag names, SHAs. Returns true for empty string
 *  (treated as "working tree" by render.ts). */
function isLikelyValidRef(ref: string): boolean {
  if (ref === "" || ref === "working") return true;
  // Try to verify with git in the current directory; if no repo, accept
  // (validation will happen in render.ts when actually used).
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref + "^{}"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  let i = 0;
  let expectedType: "pcb" | "sch" | undefined;

  // Detect leading pcb/sch subcommand
  if (argv[0] === "pcb" || argv[0] === "sch") {
    expectedType = argv[0];
    i = 1;
  }

  // Split args into pre-`--` and post-`--`. Also collect flag options.
  const positional: string[] = [];
  const filesAfterDash: string[] = [];
  let sawDoubleDash = false;
  let fromRef: string | undefined;
  let toRef: string | undefined;
  let outputDir: string | undefined;
  let imagesOnly = false;
  let open: string | undefined;

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (sawDoubleDash) {
      filesAfterDash.push(arg);
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
      // --open[=target] or --open <target>; target defaults to "xdg".
      // For `--open <target>` (space-separated), only consume the next arg
      // if it's in KNOWN_OPEN_TARGETS to avoid swallowing positional args.
      // For arbitrary commands, use `--open=<cmd>` (with `=`).
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

  // Determine which positional is the file, which are refs.
  // Rule: if `--` was used, everything after is files; everything before is refs.
  // Otherwise: the LAST positional ending in .kicad_{pcb,sch} is the file,
  // and earlier positionals are refs.
  let file: string;
  let refTokens: string[];
  if (sawDoubleDash) {
    if (filesAfterDash.length !== 1) {
      throw new Error(`expected exactly 1 file after \`--\`, got ${filesAfterDash.length}`);
    }
    file = filesAfterDash[0];
    refTokens = positional;
  } else {
    const fileIdx = positional.findIndex(isKicadFile);
    if (fileIdx === -1) {
      throw new Error(`no KiCad file (.kicad_pcb or .kicad_sch) in arguments`);
    }
    if (positional.slice(fileIdx + 1).length > 0) {
      throw new Error(`extra arguments after file: ${positional.slice(fileIdx + 1).join(" ")}`);
    }
    file = positional[fileIdx];
    refTokens = positional.slice(0, fileIdx);
  }

  // Expand `<r1>..<r2>` range into two refs
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

  // Validate refs early so users get a clear error message
  if (fromRef !== undefined && !isLikelyValidRef(fromRef)) {
    throw new Error(`bad ref: ${fromRef}`);
  }
  if (toRef !== undefined && !isLikelyValidRef(toRef)) {
    throw new Error(`bad ref: ${toRef}`);
  }

  // Validate subcommand vs file extension
  if (expectedType === "pcb" && !file.endsWith(".kicad_pcb")) {
    throw new Error(`pcb subcommand requires a .kicad_pcb file, got: ${file}`);
  }
  if (expectedType === "sch" && !file.endsWith(".kicad_sch")) {
    throw new Error(`sch subcommand requires a .kicad_sch file, got: ${file}`);
  }

  return { file, fromRef, toRef, outputDir, imagesOnly, expectedType, open };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
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
    const result = render({
      filePath: parsed.file,
      outputDir: parsed.outputDir,
      imagesOnly: parsed.imagesOnly,
      fromRef: parsed.fromRef,
      toRef: parsed.toRef,
      open: parsed.open,
    });
    printSummary(result, !!parsed.imagesOnly);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();

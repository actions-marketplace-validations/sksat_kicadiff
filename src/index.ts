#!/usr/bin/env node
/**
 * kicadiff CLI entry point.
 *
 * Usage (git-diff-like):
 *   kicadiff <file>                       Compare working tree to HEAD (default)
 *   kicadiff pcb <file>                   Same, with explicit pcb subcommand
 *   kicadiff sch <file>                   Same, with explicit sch subcommand
 *   kicadiff <file> --from <ref>          Compare working tree to <ref>
 *   kicadiff <file> --from <r1> --to <r2> Compare two refs
 *
 * Options:
 *   --output-dir <dir>      Output directory (default: <repo>/.claude/preview)
 *   --images-only           Skip HTML generation and VSCode auto-open
 *   --from <ref>            Base ref (default: HEAD)
 *   --to <ref>              Target ref (default: working tree)
 */

import { render, printSummary } from "./render.ts";

function usage(): void {
  console.log(`kicadiff — Visual diff for KiCad files

Usage:
  kicadiff <file.kicad_pcb|sch> [options]
  kicadiff pcb <file.kicad_pcb> [options]
  kicadiff sch <file.kicad_sch> [options]

Options:
  --from <ref>           Base ref to compare (default: HEAD)
  --to <ref>             Target ref to compare (default: working tree)
  --output-dir <dir>     Output directory (default: <repo>/.claude/preview)
  --images-only          Skip HTML generation and VSCode auto-open
  -h, --help             Show this help

Examples:
  kicadiff board.kicad_pcb                    # working tree vs HEAD
  kicadiff board.kicad_pcb --from main         # working tree vs main
  kicadiff board.kicad_pcb --from v1.0 --to v2.0
`);
}

interface ParsedArgs {
  file: string;
  fromRef?: string;
  toRef?: string;
  outputDir?: string;
  imagesOnly?: boolean;
  expectedType?: "pcb" | "sch";
}

function parseArgs(argv: string[]): ParsedArgs {
  let i = 0;
  let expectedType: "pcb" | "sch" | undefined;

  // Detect leading subcommand
  if (argv[0] === "pcb" || argv[0] === "sch") {
    expectedType = argv[0];
    i = 1;
  }

  const positional: string[] = [];
  let fromRef: string | undefined;
  let toRef: string | undefined;
  let outputDir: string | undefined;
  let imagesOnly = false;

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") {
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
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error(`expected exactly 1 file argument, got ${positional.length}`);
  }
  const file = positional[0];

  // Validate subcommand vs file extension
  if (expectedType === "pcb" && !file.endsWith(".kicad_pcb")) {
    throw new Error(`pcb subcommand requires a .kicad_pcb file, got: ${file}`);
  }
  if (expectedType === "sch" && !file.endsWith(".kicad_sch")) {
    throw new Error(`sch subcommand requires a .kicad_sch file, got: ${file}`);
  }

  return { file, fromRef, toRef, outputDir, imagesOnly, expectedType };
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
    });
    printSummary(result, !!parsed.imagesOnly);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();

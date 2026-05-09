/**
 * Text-based structural diff for KiCad files.
 *
 * Parses .kicad_pcb / .kicad_sch S-expressions and reports added, removed,
 * and changed components keyed by their Reference designator (e.g. "C42").
 * The output is a compact, human-readable summary suitable for terminals,
 * commit messages, or CI logs — complementary to the visual HTML diff.
 *
 * Intentionally does NOT try to be a complete schematic differ — wires,
 * net classes, board outlines, etc. are out of scope. The goal is "what
 * components changed?", which covers the vast majority of real edits.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileType } from "./types.ts";

// =============================================================================
// Minimal S-expression parser
// =============================================================================

/** S-expression node: either a list (of nodes) or an atom (string).
 *  Atoms include both bare identifiers (`footprint`) and quoted strings;
 *  quotes are stripped during parse so callers see the raw value. */
export type Sexp = string | Sexp[];

export function parseSexp(src: string): Sexp[] {
  let i = 0;
  const n = src.length;

  function skipWs(): void {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else {
        break;
      }
    }
  }

  function readString(): string {
    // Opening quote already consumed; read until closing quote, handling \" and \\.
    let out = "";
    while (i < n) {
      const c = src[i++];
      if (c === "\\" && i < n) {
        out += src[i++];
      } else if (c === '"') {
        return out;
      } else {
        out += c;
      }
    }
    throw new Error("unterminated string");
  }

  function readAtom(): string {
    let out = "";
    while (i < n) {
      const c = src[i];
      if (c === "(" || c === ")" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
      out += c;
      i++;
    }
    return out;
  }

  function readList(): Sexp[] {
    const list: Sexp[] = [];
    while (i < n) {
      skipWs();
      if (i >= n) throw new Error("unterminated list");
      const c = src[i];
      if (c === ")") { i++; return list; }
      if (c === "(") { i++; list.push(readList()); }
      else if (c === '"') { i++; list.push(readString()); }
      else { list.push(readAtom()); }
    }
    throw new Error("unterminated list");
  }

  const result: Sexp[] = [];
  skipWs();
  while (i < n) {
    const c = src[i];
    if (c === "(") { i++; result.push(readList()); skipWs(); }
    else if (c === '"') { i++; result.push(readString()); skipWs(); }
    else { result.push(readAtom()); skipWs(); }
  }
  return result;
}

// =============================================================================
// Component extraction
// =============================================================================

export interface Component {
  /** Reference designator (e.g. "U1", "C42"). Used as the diff identity. */
  ref: string;
  /** Value text (e.g. "100nF", "RP2040"). */
  value: string;
  /** Library ID — footprint name for PCB, symbol lib_id for sch. */
  libId: string;
  /** Position as "x,y" (rounded), or undefined if not present. */
  pos?: string;
  /** Rotation angle in degrees as a string, or undefined. */
  angle?: string;
}

/** Walk a parsed tree and call `visit` on every list whose head is `head`.
 *  Used to find all `(footprint ...)` or `(symbol ...)` blocks regardless
 *  of nesting depth. */
function walk(tree: Sexp[] | Sexp, head: string, visit: (node: Sexp[]) => void): void {
  if (typeof tree === "string") return;
  if (Array.isArray(tree)) {
    if (tree.length > 0 && tree[0] === head) visit(tree);
    for (const child of tree) walk(child, head, visit);
  }
}

/** Find a property by name within a footprint/symbol node. KiCad represents
 *  properties as `(property "Name" "Value" ...)`; we return just the value. */
function findProperty(node: Sexp[], name: string): string | undefined {
  for (const child of node) {
    if (Array.isArray(child) && child[0] === "property" && child[1] === name) {
      return typeof child[2] === "string" ? child[2] : undefined;
    }
  }
  return undefined;
}

/** Extract `(at x y [angle])` position. Returns "x,y" rounded to 2dp and
 *  the angle separately (so position can be diffed without angle noise). */
function findAt(node: Sexp[]): { pos?: string; angle?: string } {
  for (const child of node) {
    if (Array.isArray(child) && child[0] === "at") {
      const x = child[1], y = child[2], a = child[3];
      if (typeof x === "string" && typeof y === "string") {
        const px = Number(x), py = Number(y);
        const pos = `${px.toFixed(2)},${py.toFixed(2)}`;
        const angle = typeof a === "string" ? a : undefined;
        return { pos, angle };
      }
    }
  }
  return {};
}

export function extractComponents(src: string, fileType: FileType): Component[] {
  const tree = parseSexp(src);
  const out: Component[] = [];

  if (fileType === "pcb") {
    // PCB: (footprint "lib:name" ... (property "Reference" "U1" ...) ...)
    walk(tree, "footprint", node => {
      const libId = typeof node[1] === "string" ? node[1] : "";
      const ref = findProperty(node, "Reference") ?? "";
      const value = findProperty(node, "Value") ?? "";
      if (!ref) return;
      const { pos, angle } = findAt(node);
      out.push({ ref, value, libId, pos, angle });
    });
  } else if (fileType === "sch") {
    // Schematic: (symbol (lib_id "...") ... (property "Reference" "U1" ...))
    // Skip lib_symbols entries (these are template symbols, not instances).
    walk(tree, "symbol", node => {
      // Heuristic: instances have a (uuid ...) and (at x y) at the top level;
      // template symbols inside (lib_symbols ...) do not.
      const hasUuid = node.some(c => Array.isArray(c) && c[0] === "uuid");
      const hasAt = node.some(c => Array.isArray(c) && c[0] === "at");
      if (!hasUuid || !hasAt) return;
      const libIdNode = node.find(c => Array.isArray(c) && c[0] === "lib_id");
      const libId = Array.isArray(libIdNode) && typeof libIdNode[1] === "string" ? libIdNode[1] : "";
      const ref = findProperty(node, "Reference") ?? "";
      const value = findProperty(node, "Value") ?? "";
      if (!ref) return;
      const { pos, angle } = findAt(node);
      out.push({ ref, value, libId, pos, angle });
    });
  }

  // Sort for deterministic output (also stable across runs)
  out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return out;
}

// =============================================================================
// Diff
// =============================================================================

export interface ComponentDiff {
  added: Component[];
  removed: Component[];
  changed: { ref: string; before: Component; after: Component; fields: string[] }[];
  unchanged: number;
}

export function diffComponents(before: Component[], after: Component[]): ComponentDiff {
  const beforeMap = new Map(before.map(c => [c.ref, c]));
  const afterMap = new Map(after.map(c => [c.ref, c]));

  const added: Component[] = [];
  const removed: Component[] = [];
  const changed: ComponentDiff["changed"] = [];
  let unchanged = 0;

  for (const [ref, b] of beforeMap) {
    const a = afterMap.get(ref);
    if (!a) {
      removed.push(b);
      continue;
    }
    const fields: string[] = [];
    if (a.value !== b.value) fields.push("value");
    if (a.libId !== b.libId) fields.push("libId");
    if (a.pos !== b.pos) fields.push("pos");
    if (a.angle !== b.angle) fields.push("angle");
    if (fields.length > 0) changed.push({ ref, before: b, after: a, fields });
    else unchanged++;
  }
  for (const [ref, a] of afterMap) {
    if (!beforeMap.has(ref)) added.push(a);
  }
  return { added, removed, changed, unchanged };
}

// =============================================================================
// CLI integration
// =============================================================================

/** Read the file content at a git ref (or working tree). Returns undefined
 *  if the file does not exist at that ref. */
function readAtRef(filePath: string, ref: string, repoRoot: string | null): string | undefined {
  if (ref === "" || ref === "working") {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  }
  if (!repoRoot) return undefined;
  const rel = path.relative(repoRoot, filePath);
  // Verify the file exists at this ref before trying to read it
  const exists = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${rel}`]).status === 0;
  if (!exists) return undefined;
  return execFileSync("git", ["-C", repoRoot, "show", `${ref}:${rel}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export interface FileDiff {
  fileType: FileType;
  rel: string;
  diff: ComponentDiff;
}

/** Compute a structural component diff for a single KiCad file. The result is
 *  format-agnostic — both textDiff and markdownDiff render it. */
export function computeFileDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): FileDiff {
  let fileType: FileType;
  if (filePath.endsWith(".kicad_pcb")) fileType = "pcb";
  else if (filePath.endsWith(".kicad_sch")) fileType = "sch";
  else throw new Error(`text diff only supports .kicad_pcb / .kicad_sch (got: ${filePath})`);

  const beforeSrc = readAtRef(filePath, fromRef, repoRoot);
  const afterSrc = readAtRef(filePath, toRef, repoRoot);

  const before = beforeSrc ? extractComponents(beforeSrc, fileType) : [];
  const after = afterSrc ? extractComponents(afterSrc, fileType) : [];

  const rel = repoRoot ? path.relative(repoRoot, filePath) : filePath;
  return { fileType, rel, diff: diffComponents(before, after) };
}

/** Render a textual diff for a single KiCad file. Returns a multi-line string. */
export function textDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): string {
  const { fileType, rel, diff: d } = computeFileDiff(filePath, fromRef, toRef, repoRoot);
  const lines: string[] = [];
  lines.push(`${rel} (${fileType}): +${d.added.length} -${d.removed.length} ~${d.changed.length} =${d.unchanged}`);

  for (const c of d.added) {
    lines.push(`  + ${c.ref} ${c.value} [${c.libId}]${c.pos ? ` at (${c.pos})` : ""}`);
  }
  for (const c of d.removed) {
    lines.push(`  - ${c.ref} ${c.value} [${c.libId}]${c.pos ? ` at (${c.pos})` : ""}`);
  }
  for (const ch of d.changed) {
    const parts: string[] = [];
    for (const f of ch.fields) {
      const bv = (ch.before as unknown as Record<string, string | undefined>)[f] ?? "";
      const av = (ch.after as unknown as Record<string, string | undefined>)[f] ?? "";
      parts.push(`${f}: ${bv} → ${av}`);
    }
    lines.push(`  ~ ${ch.ref}  ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

/** Render a markdown diff for a single KiCad file. Suitable for pasting into
 *  PR descriptions, issue comments, or commit messages — refs, values, and
 *  field names are wrapped in backticks for monospace rendering. */
export function markdownDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): string {
  const { fileType, rel, diff: d } = computeFileDiff(filePath, fromRef, toRef, repoRoot);
  const lines: string[] = [];

  // File header. Backtick the path so it renders monospace and won't be
  // interpreted as markdown formatting if it contains `_` or other chars.
  lines.push(`## \`${rel}\` (${fileType})`);
  lines.push("");
  lines.push(`\`+${d.added.length}\` \`-${d.removed.length}\` \`~${d.changed.length}\` \`=${d.unchanged}\``);

  if (d.added.length > 0) {
    lines.push("");
    lines.push(`### Added (${d.added.length})`);
    for (const c of d.added) {
      const at = c.pos ? ` at \`(${c.pos})\`` : "";
      lines.push(`- \`${c.ref}\` \`${c.value}\` \`${c.libId}\`${at}`);
    }
  }
  if (d.removed.length > 0) {
    lines.push("");
    lines.push(`### Removed (${d.removed.length})`);
    for (const c of d.removed) {
      const at = c.pos ? ` at \`(${c.pos})\`` : "";
      lines.push(`- \`${c.ref}\` \`${c.value}\` \`${c.libId}\`${at}`);
    }
  }
  if (d.changed.length > 0) {
    lines.push("");
    lines.push(`### Changed (${d.changed.length})`);
    for (const ch of d.changed) {
      const parts: string[] = [];
      for (const f of ch.fields) {
        const bv = (ch.before as unknown as Record<string, string | undefined>)[f] ?? "";
        const av = (ch.after as unknown as Record<string, string | undefined>)[f] ?? "";
        parts.push(`${f}: \`${bv}\` → \`${av}\``);
      }
      lines.push(`- \`${ch.ref}\` — ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}

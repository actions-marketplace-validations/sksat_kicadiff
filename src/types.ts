/**
 * Shared types for kicadiff CLI and viewer.
 * Manifest is the JSON structure injected into viewer.html via <script>.
 */

export type FileType = "pcb" | "sch" | "sym" | "fp";

/** A single schematic page (multi-sheet support).
 *  `name` is the page identifier extracted from the SVG filename — for the root
 *  sheet it is the project basename; for subsheets it is the suffix after the
 *  project basename and `-`. `hasDiff` is set on the after-side entry only,
 *  computed by comparing before/after PNG bytes for the same page name. */
export interface SchPage {
  name: string;
  png: string;
  hasDiff?: boolean;
}

export interface SideManifest {
  /** Combined image (all layers merged for PCB; root sheet for sch) —
   *  relative path from HTML */
  combined: string;
  /** Per-layer images (PCB only) — relative paths from HTML, keyed by layer name */
  layers?: Record<string, string>;
  /** Multi-sheet schematic pages (sch only). Always includes the root sheet.
   *  Length > 1 indicates a hierarchical schematic; viewer shows a page selector. */
  pages?: SchPage[];
}

/** A single rendered file. Embedded in the viewer as either
 *  `window.MANIFEST` directly (single-file mode) or as one entry of
 *  `window.MANIFEST.files` (combined project mode). */
export interface FileManifest {
  /** Original file path (relative to repo root if available) */
  file: string;
  /** File type — pcb, sch, sym (symbol library), or fp (footprint library) */
  type: FileType;
  /** Whether the before state was successfully rendered from git HEAD */
  hasBefore: boolean;
  /** Whether the after state was successfully rendered (false when the file
   *  is deleted at the target ref). When false, `after` is omitted and the
   *  viewer falls back to showing only the before side. */
  hasAfter?: boolean;
  /** True if the visual output actually changed between before and after.
   *  Computed by comparing the combined PNG bytes — survives noise that doesn't
   *  affect rendering (whitespace, comment changes). Used by the viewer to
   *  highlight tabs that have real differences vs. tabs that don't. */
  hasDiff?: boolean;
  /** Git ref used as the before side (e.g. "HEAD", "main", "abc1234").
   *  Echoed to the viewer so reviewers can see what they're comparing
   *  against in side-by-side / overlay / swipe labels. */
  fromRef?: string;
  /** Git ref used as the after side. Empty string ("") means working tree —
   *  the viewer renders this as "working tree" or "edited". */
  toRef?: string;
  after?: SideManifest;
  before?: SideManifest;
  /** Diff highlight image (ImageMagick compare output), present only if both
   *  before and after were rendered and ImageMagick is available */
  diff?: string;
}

/** Backward-compat alias used by older single-file callers. */
export type Manifest = FileManifest;

/** Combined manifest used when rendering multiple files (e.g. PCB + schematic
 *  of the same project). The viewer shows top-level tabs to switch between
 *  files, each containing the existing UI (view modes, layer panel, etc.). */
export interface ProjectManifest {
  files: FileManifest[];
}

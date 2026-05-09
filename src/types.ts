/**
 * Shared types for kicadiff CLI and viewer.
 * Manifest is the JSON structure injected into viewer.html via <script>.
 */

export type FileType = "pcb" | "sch";

export interface SideManifest {
  /** Combined image (all layers merged) — relative path from HTML */
  combined: string;
  /** Per-layer images (PCB only) — relative paths from HTML, keyed by layer name */
  layers?: Record<string, string>;
}

/** A single rendered file (PCB or schematic). Embedded in the viewer as either
 *  `window.MANIFEST` directly (single-file mode) or as one entry of
 *  `window.MANIFEST.files` (combined project mode). */
export interface FileManifest {
  /** Original file path (relative to repo root if available) */
  file: string;
  /** File type — pcb or sch */
  type: FileType;
  /** Whether the before state was successfully rendered from git HEAD */
  hasBefore: boolean;
  after: SideManifest;
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

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

export interface Manifest {
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

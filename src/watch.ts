/**
 * --watch implementation.
 *
 * Long-lived re-render loop: watches the resolved input KiCad files and
 * re-runs renderProject() (cache-enabled) whenever one changes. The watch
 * loop itself does *not* run an HTTP server — composing well with whatever
 * the user already has serving the HTML is more flexible than baking one
 * in. Two reload paths cover the common cases:
 *
 *   1. **Servers that already auto-reload** (VSCode Live Preview / Simple
 *      Browser, live-server, browsersync, …). They watch the served files
 *      themselves; once kicadiff overwrites the images / HTML, they push
 *      a reload to the browser. `--open vscode` is the easy default.
 *
 *   2. **Plain `file://` in a regular browser.** Browser security blocks
 *      WebSockets and same-origin fetch from file://, so there's no
 *      server-pushed reload available. Workaround: when the watch loop
 *      writes the diff HTML it injects a tiny polling script that
 *      periodically cache-busts every <img src> — the browser refetches
 *      from disk and the rendered images update in place. State (scroll,
 *      layer toggles, view mode) is preserved because the page itself
 *      never reloads.
 *
 * To avoid file-watching tools re-triggering their own reload for no
 * reason, we hash the freshly-built HTML and only rewrite when it has
 * actually changed.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { renderProject, resolveInputs } from "./render.ts";
import type { ProjectRenderOptions } from "./render.ts";

/** Inline client that periodically refreshes <img> sources so file://
 *  viewers update without manual F5. Skips imgs whose src is empty or a
 *  data: URL (data URIs don't benefit from cache-bust and the regex would
 *  blow up the string). */
const FILE_RELOAD_CLIENT = `
<script>
(function () {
  var INTERVAL_MS = 1500;
  function bust(src) {
    if (!src || src.indexOf("data:") === 0) return src;
    try {
      var u = new URL(src, location.href);
      u.searchParams.set("_t", Date.now().toString(36));
      return u.toString();
    } catch (e) { return src; }
  }
  function refresh() {
    document.querySelectorAll("img").forEach(function (img) {
      if (img.src) img.src = bust(img.src);
    });
  }
  setInterval(refresh, INTERVAL_MS);
})();
</script>
`;

/** Inject the file-reload polling script before </body> in the given HTML
 *  on disk. Hashes the existing file so a no-op (already-injected) doesn't
 *  rewrite and trigger downstream watchers. Returns the new content hash. */
function ensureWatchScriptInjected(htmlPath: string): string {
  const original = fs.readFileSync(htmlPath, "utf8");
  if (original.includes("KICADIFF_WATCH_INJECTED")) {
    // Already patched (unchanged from previous render). No-op.
    return crypto.createHash("sha256").update(original).digest("hex");
  }
  const marker = "<!-- KICADIFF_WATCH_INJECTED -->";
  const i = original.lastIndexOf("</body>");
  const patched = i >= 0
    ? original.slice(0, i) + marker + FILE_RELOAD_CLIENT + original.slice(i)
    : original + marker + FILE_RELOAD_CLIENT;
  fs.writeFileSync(htmlPath, patched);
  return crypto.createHash("sha256").update(patched).digest("hex");
}

export type WatchOptions = ProjectRenderOptions;

/** Run the initial render, then watch the resolved input KiCad files and
 *  re-render on every change. Blocks until SIGINT/SIGTERM. */
export async function startWatch(opts: WatchOptions): Promise<void> {
  // Initial render. We surface its result so the first session opens the
  // viewer / writes the HTML in the same shape as a non-watch run.
  const initial = await renderProject(opts);
  const htmlPath = initial.combinedHtml ?? initial.results[0]?.diffHtml ?? null;
  // Inject the file:// polling script so plain-browser users see updates
  // without F5. Servers that already hot-reload (Live Preview, etc.) ignore
  // the extra setInterval — it just runs alongside their own logic.
  let lastHtmlHash = htmlPath ? ensureWatchScriptInjected(htmlPath) : null;

  const inputs = resolveInputs(opts.input, opts.scope);
  if (inputs.length === 0) {
    throw new Error("watch: no KiCad files resolved from input");
  }
  const printable = inputs.map((p) => relativeOrAbsolute(p)).join(", ");
  console.log(`kicadiff --watch: watching ${printable}`);
  console.log(`  (hot reload comes from your viewer — open the HTML in`);
  console.log(`   VSCode Live Preview / live-server / similar for auto-reload)`);

  // Coalesce rapid event bursts (editor atomic-write rename → multiple events
  // in <50ms) into a single re-render via a short debounce window.
  let pending: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  async function rerenderOnce() {
    const start = Date.now();
    try {
      // Cache stays on: only the changed file's hash differs, the others
      // hit cache and return in the millisecond range.
      const r = await renderProject({ ...opts, open: undefined });
      const newPath = r.combinedHtml ?? r.results[0]?.diffHtml ?? null;
      // Re-inject the polling script (renderProject would have rewritten the
      // HTML without it). Returns the patched content's hash so we can
      // compare against the previous patched HTML.
      const newHash = newPath ? ensureWatchScriptInjected(newPath) : null;
      const elapsed = Date.now() - start;
      if (newHash !== lastHtmlHash) {
        lastHtmlHash = newHash;
        console.log(`re-rendered in ${elapsed}ms (HTML rewritten)`);
      } else {
        console.log(`re-rendered in ${elapsed}ms (HTML unchanged)`);
      }
    } catch (e) {
      console.error(`re-render failed: ${(e as Error).message}`);
    }
  }

  function trigger() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      // Serialise: if a render is already in flight, queue one more pass
      // after it completes so we never miss an event.
      if (inFlight) {
        await inFlight;
      }
      inFlight = rerenderOnce().finally(() => { inFlight = null; });
      await inFlight;
    }, 200);
  }

  // We use fs.watchFile (polling) rather than fs.watch (inotify-style):
  // editors like KiCad / vim atomically replace files via rename, which
  // breaks the inode-bound fs.watch handle (events fire once on the rename
  // and then the watcher is dead). Polling stat at 1 s is reliable across
  // every editor and the cost is negligible for a handful of files.
  for (const file of inputs) {
    fs.watchFile(file, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) trigger();
    });
  }

  // Block until the user kills us.
  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const file of inputs) fs.unwatchFile(file);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** Display path: prefer cwd-relative when the file is inside cwd, else
 *  the absolute path verbatim. */
function relativeOrAbsolute(p: string): string {
  const cwd = process.cwd();
  if (p.startsWith(cwd + "/") || p === cwd) return p.slice(cwd.length + 1) || ".";
  return p;
}

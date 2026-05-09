# kicadiff

Visual diff tool for KiCad projects — see what changed between two
states of a `.kicad_pcb` / `.kicad_sch` / `.kicad_sym` / `.kicad_mod`
file in your browser, or as a markdown report you can paste into a PR.

[日本語版 README](./README.ja.md)

![kicadiff demo](assets/kicadiff-demo.gif)

## What you get

- **HTML viewer** with side-by-side / overlay / swipe modes, layer toggles
  for PCBs, page navigation for hierarchical schematics, wheel-to-zoom and
  right-click-drag-to-pan, and an amber tab marker on files / pages whose
  rendered output actually changed.
- **Markdown report** (`--md`) with side-by-side image tables and a
  structural component diff (added / removed / changed by reference
  designator). Good for PR descriptions and commit messages.
- **Text-only structural diff** (`--text-only`) — fast, no image
  rendering, prints to stdout.

## Requirements

The end-goal is for `kicad-cli` to be the only runtime dependency.
We're not there yet — `rsvg-convert` and ImageMagick are still
needed transiently. Tracked in `DESIGN.md` (Runtime dependencies).

- [`kicad-cli`](https://www.kicad.org/) 9.x or later (rendering engine)
- `rsvg-convert` from `librsvg` (SVG → PNG; transient — to be replaced
  by an in-process WASM rasterizer)
- ImageMagick `magick` command (highlight overlay; optional, transient)
- [Bun](https://bun.sh) — runs the TypeScript CLI directly via shebang.
  Bun is also what compiles the standalone binary, so no separate Node
  install is needed for any workflow.

## Usage

`kicadiff` works on the same positional argument shape as `git diff`,
plus a few subcommands when you want to scope to one file type.

```sh
# Project-level diff (cwd, both PCB and schematic, default = HEAD vs working tree)
kicadiff

# Pass a project root, a .kicad_pro, or any single KiCad file
kicadiff path/to/project/
kicadiff project.kicad_pro
kicadiff project.kicad_pcb

# Compare arbitrary refs
kicadiff main path/to/project/         # working tree vs main
kicadiff v1.0 v2.0 board.kicad_pcb     # v1.0 vs v2.0
kicadiff main..feat foo.kicad_pcb      # range syntax
kicadiff main -- foo.kicad_pcb         # explicit `--` separator

# Subcommands scope to one file type (skip sibling auto-detect)
kicadiff pcb foo.kicad_pcb
kicadiff sch foo.kicad_sch       # alias: schematic
kicadiff sym lib.kicad_sym       # alias: symbol
kicadiff fp foo.kicad_mod        # alias: footprint
kicadiff fp lib.pretty           # whole .pretty/ library

# Output formats
kicadiff project/                       # default: HTML viewer + images
kicadiff project/ --md                  # markdown report + images, no HTML
kicadiff project/ --md --output report.md
kicadiff project/ --md --output -       # markdown to stdout, logs to stderr
kicadiff project/ --text                # also print structural text diff
kicadiff project/ --text-only           # text only, skip rendering (fast)
kicadiff project/ --images-only         # PNGs only, no HTML / markdown

# Custom markdown templates (Mustache subset: {{var}}, {{#section}}…{{/section}},
# {{^inverted}}…{{/inverted}}). Project template sees from_label / to_label /
# file_count / has_changes / files / file_sections. File template sees path /
# type / before_image / after_image / has_both / after_only / before_only /
# added_count / removed_count / changed_count / unchanged_count /
# has_structural_diff (real component changes) / has_visual_diff (PNGs differ) /
# has_changes (any of the above) / structural_diff (formatted body). Either
# flag is optional; the default template ships built-in.
kicadiff project/ --md --md-template my-report.md.tpl
kicadiff project/ --md --md-file-template my-file.md.tpl

# Auto-open the HTML in VSCode (Live Preview), a browser, etc.
kicadiff project/ --open vscode
kicadiff project/ --open firefox
kicadiff project/ --open=/usr/bin/open  # arbitrary command

# Other
kicadiff project/ -v                    # verbose summary (full PNG paths)
kicadiff project/ -q                    # suppress summary
kicadiff project/ --no-cache            # bypass the render cache

# Claude Code PostToolUse hook integration. Reads the hook JSON from
# stdin, renders only when the edited file is .kicad_pcb / .kicad_sch.
# Default: --open vscode (override with --open <target> as usual).
kicadiff hook
```

## Output

By default kicadiff writes to `<repo>/.claude/preview/` (next to the git
root) so the directory is easy to find from the project. Override with
`--output-dir <dir>` for the image directory, and `--output <path>` to
relocate the HTML / markdown file specifically (image paths in the
file get rewritten to be relative to it, so the file stays portable).

The HTML viewer is a single file with the manifest + image references
inline; you can email it, host it as a static asset, or open it
locally with VSCode's Live Preview extension.

## Render cache

Every per-side render is content-addressed and cached under
`$XDG_CACHE_HOME/kicadiff` (or `~/.cache/kicadiff`). Repeat runs
against unchanged content return in ~1 s vs ~5 s cold. Bypass with
`--no-cache` or override the location with `KICADIFF_CACHE_DIR`.

## More

- `DESIGN.md` — architecture, render pipeline, cache key shape,
  manifest schema, viewer mode semantics
- `examples/blink/` — minimal KiCad project used as the test fixture
  and a usable starting point. Ships with a `.claude/settings.json`
  PostToolUse hook (`kicadiff hook`) that re-renders the diff every
  time a `.kicad_pcb` / `.kicad_sch` is Edited / Written.
- `examples/mcu-board/` — a more realistic small-board layout: an
  8-pin MCU stand-in with the usual stuff around it (5 V → 3.3 V
  AMS1117 LDO, decoupling caps, reset switch with pull-up, status
  LED, and a 6-pin programming/breakout header). Hierarchical
  schematic — root for the power chain and MCU itself,
  `peripherals.kicad_sch` sub-sheet for the reset/LED/header — so
  the per-page tabs in the viewer have something to switch between.

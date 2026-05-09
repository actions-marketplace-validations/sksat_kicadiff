# kicadiff — development policies

Meta development conventions for this project. Concrete design lives in
`DESIGN.md`; user-facing usage lives in `README.md`. This file is for
*how we work*, not *what the project is*.

## Test-driven development

New behavior is introduced test-first: write a failing test that asserts
the user-observable result, watch it fail, then implement until it
passes. Bug fixes get a regression test before the fix.

The test suite is the fastest way to learn what the project does, so
keeping it green and *inclusive* matters more than runtime. A new test
that documents a real behavior is welcome even if it adds a few seconds.

## Comments

Lean toward writing them when the *why* would surprise someone reading
cold. This codebase sits on top of kicad-cli, rsvg-convert,
ImageMagick, and the browser layout engine, so the share of code where
"why is this flag / this CSS rule / this path operation here?" is
non-obvious is higher than usual — a one- or two-line explanation in
those spots is worth keeping.

## Self-contained changes

Each commit is single-purpose. Unrelated cleanups go in their own
commits, even when discovered while working on a feature. The body of
the commit explains *why*; the subject is a short label. When a feature
naturally spans several files (e.g. CLI flag + render plumbing + viewer
update + tests), keep them in one commit, but don't drag in unrelated
edits.

## Update docs alongside code

When a change affects:

- Public CLI surface (flags, subcommands, output paths) → `README.md`
  needs an update.
- Architecture decisions (a new file type, a different cache key, a
  refactor of the manifest) → `DESIGN.md` should reflect the new shape.
- Working conventions themselves → this file.

A change that needs a doc update but doesn't include one is incomplete.

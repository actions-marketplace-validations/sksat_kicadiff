import { test, expect } from "@playwright/test";
import { renderTemplate } from "../src/template.ts";

// Pure-logic unit tests; we still use the Playwright runner so we don't pull
// in a separate test framework. No browser is launched.

test("variable substitution", () => {
  expect(renderTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
});

test("missing variable renders as empty string", () => {
  expect(renderTemplate("a={{a}}, b={{b}}", { a: 1 })).toBe("a=1, b=");
});

test("dot-path variable lookup", () => {
  expect(renderTemplate("{{file.path}}", { file: { path: "x.kicad_pcb" } }))
    .toBe("x.kicad_pcb");
});

test("truthy section renders once", () => {
  expect(renderTemplate("{{#ok}}yes{{/ok}}", { ok: true })).toBe("yes");
});

test("falsy section renders nothing", () => {
  expect(renderTemplate("{{#ok}}yes{{/ok}}", { ok: false })).toBe("");
});

test("inverted section renders only when falsy", () => {
  expect(renderTemplate("{{^ok}}no{{/ok}}", { ok: false })).toBe("no");
  expect(renderTemplate("{{^ok}}no{{/ok}}", { ok: true })).toBe("");
});

test("array section iterates and exposes item fields", () => {
  const out = renderTemplate(
    "{{#items}}- {{name}}\n{{/items}}",
    { items: [{ name: "a" }, { name: "b" }] },
  );
  expect(out).toBe("- a\n- b\n");
});

test("empty array section renders nothing", () => {
  expect(renderTemplate("{{#xs}}.{{/xs}}", { xs: [] })).toBe("");
});

test("inverted on empty array renders block", () => {
  expect(renderTemplate("{{^xs}}empty{{/xs}}", { xs: [] })).toBe("empty");
});

test("inner block can access outer scope", () => {
  const out = renderTemplate(
    "{{#files}}{{path}} ({{from_ref}}){{/files}}",
    { from_ref: "HEAD", files: [{ path: "a.kicad_pcb" }] },
  );
  expect(out).toBe("a.kicad_pcb (HEAD)");
});

test("nested same-name sections", () => {
  // Mostly a pathological case but the depth tracking should handle it.
  const out = renderTemplate(
    "{{#x}}A{{#x}}B{{/x}}C{{/x}}",
    { x: { x: true } },
  );
  expect(out).toBe("ABC");
});

test("nested different-name sections", () => {
  const out = renderTemplate(
    "{{#a}}[{{#b}}{{name}}{{/b}}]{{/a}}",
    { a: { b: { name: "hit" } } },
  );
  expect(out).toBe("[hit]");
});

test("comments are skipped", () => {
  expect(renderTemplate("a{{!hidden}}b", {})).toBe("ab");
});

test("unterminated tag is emitted as literal", () => {
  // Defensive: don't silently swallow malformed input; emit it so the author
  // can see the problem in the output.
  expect(renderTemplate("hello {{name", { name: "x" })).toBe("hello {{name");
});

test("unmatched section open is emitted as literal", () => {
  expect(renderTemplate("{{#a}}body", { a: true })).toBe("{{#a}}body");
});

// `renderInner` already trims section names, so the same input with extra
// whitespace inside the tag should behave identically. Standard Mustache
// implementations all do this; if we don't, custom templates that round-trip
// through formatters (which often pad delimiters) break in surprising ways.
test("section close tag accepts whitespace around the name", () => {
  expect(renderTemplate("{{#x}}A{{/ x}}", { x: true })).toBe("A");
  expect(renderTemplate("{{#x}}B{{/x }}", { x: true })).toBe("B");
  expect(renderTemplate("{{# x }}C{{/ x }}", { x: true })).toBe("C");
});

test("nested section close tags accept whitespace too", () => {
  // Depth tracking must still work across whitespace variants of the same
  // key, otherwise nested same-name sections would mis-pair.
  const out = renderTemplate(
    "{{#x}}A{{# x}}B{{/x}}C{{/ x}}",
    { x: { x: true } },
  );
  expect(out).toBe("ABC");
});

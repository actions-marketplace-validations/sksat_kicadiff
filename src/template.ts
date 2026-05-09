/** Minimal Mustache-subset template engine.
 *
 * Markdown report templating only needs three things, so we ship a tiny
 * inline implementation rather than pulling in a full Mustache dep:
 *
 *   {{var}}                       — variable substitution (no escaping; the
 *                                   output is markdown, not HTML)
 *   {{#section}}…{{/section}}     — truthy block:
 *                                     - array → iterate, each item is the
 *                                       inner context
 *                                     - object → render once with the object
 *                                       pushed onto the context stack
 *                                     - other truthy → render once with the
 *                                       outer context
 *   {{^section}}…{{/section}}     — inverted block: render if value is
 *                                   falsy / empty array
 *   {{!comment}}                  — comment (ignored at render time)
 *
 * Variable lookup walks the context stack (innermost → outermost), so a
 * file template inside `{{#files}}…{{/files}}` can still reference
 * project-level fields like `{{from_label}}`. Dot paths (`a.b.c`) are
 * supported for nested objects.
 *
 * Whitespace around standalone section tags is NOT trimmed (full Mustache
 * does this via the standalone-tag rule). Authors who care about clean
 * output should keep section tags inline with content.
 */

export type TemplateContext = Record<string, unknown>;

/** Render `template` against `ctx`. Returns the substituted string. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return renderInner(template, [ctx]);
}

type Stack = TemplateContext[];

function renderInner(template: string, stack: Stack): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf("}}", open + 2);
    if (close < 0) {
      // Unterminated tag — emit the rest as a literal so authors see the
      // problem in the output rather than getting silently swallowed text.
      out += template.slice(open);
      break;
    }
    const raw = template.slice(open + 2, close);
    const tag = raw.trim();
    const sigil = tag[0];

    if (sigil === "!") {
      // Comment — skip.
      i = close + 2;
    } else if (sigil === "#" || sigil === "^") {
      const key = tag.slice(1).trim();
      const inverted = sigil === "^";
      const innerStart = close + 2;
      const end = findSectionEnd(template, innerStart, key);
      if (end === null) {
        // Unmatched section open — emit literal and bail to avoid runaway loops.
        out += template.slice(open);
        break;
      }
      const inner = template.slice(innerStart, end.start);
      const value = lookup(stack, key);
      if (inverted) {
        if (isFalsy(value)) out += renderInner(inner, stack);
      } else {
        if (Array.isArray(value)) {
          for (const item of value) {
            const child = (item && typeof item === "object" && !Array.isArray(item))
              ? (item as TemplateContext)
              : ({ ".": item } as TemplateContext);
            out += renderInner(inner, [...stack, child]);
          }
        } else if (value && typeof value === "object") {
          out += renderInner(inner, [...stack, value as TemplateContext]);
        } else if (value) {
          out += renderInner(inner, stack);
        }
      }
      i = end.start + end.length;
    } else if (sigil === "/") {
      // Stray close tag — skip.
      i = close + 2;
    } else {
      // Variable.
      const v = lookup(stack, tag);
      if (v != null) out += String(v);
      i = close + 2;
    }
  }
  return out;
}

function isFalsy(v: unknown): boolean {
  if (v == null) return true;
  if (v === false) return true;
  if (v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/** Look up `key` (which may be a dot path) by walking the stack from inner to
 *  outer. Returns undefined if not found. */
function lookup(stack: Stack, key: string): unknown {
  if (key === ".") {
    const top = stack[stack.length - 1];
    return top ? (top as Record<string, unknown>)["."] ?? top : undefined;
  }
  const parts = key.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && parts[0] in ctx) {
      return descend((ctx as Record<string, unknown>)[parts[0]], parts.slice(1));
    }
  }
  return undefined;
}

function descend(v: unknown, parts: string[]): unknown {
  let cur = v;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Find the matching close tag for a section that started just before
 *  `from`. Returns the close tag's start offset and byte length, or null
 *  if no matching close is found.
 *
 *  The length is needed because tag whitespace is variable: `{{/x}}`,
 *  `{{/ x}}`, and `{{/ x }}` are all valid and have different lengths.
 *
 *  We walk every `{{ … }}` occurrence rather than searching for a fixed
 *  byte sequence, so that whitespace inside the tag is normalised the same
 *  way `renderInner()` does for opening tags. */
function findSectionEnd(
  s: string,
  from: number,
  key: string,
): { start: number; length: number } | null {
  let i = from;
  let depth = 0;
  while (i < s.length) {
    const open = s.indexOf("{{", i);
    if (open < 0) return null;
    const close = s.indexOf("}}", open + 2);
    if (close < 0) return null;
    const tag = s.slice(open + 2, close).trim();
    const sigil = tag[0];
    if ((sigil === "#" || sigil === "^") && tag.slice(1).trim() === key) {
      depth++;
    } else if (sigil === "/" && tag.slice(1).trim() === key) {
      if (depth === 0) return { start: open, length: close + 2 - open };
      depth--;
    }
    i = close + 2;
  }
  return null;
}

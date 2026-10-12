/**
 * Reading class-validator rules from their recorded text, e.g. `Min(5, { message: 'too small' })`.
 * Rules keep their source text so the docs can show them; these helpers pull out the arguments.
 */

/** Top-level arguments of a call's text, respecting brackets, strings and regex literals. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let regex = false;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    cur += c;
    if (quote) {
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (regex) {
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) regex = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && /^\s*$/.test(cur.slice(0, -1))) regex = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.slice(0, -1).trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The rule named `name` (exact name, with or without arguments). */
export function findRule(rules: string[], name: string): string | undefined {
  return rules.find((r) => r === name || r.startsWith(`${name}(`));
}

export function hasRule(rules: string[], name: string): boolean {
  return findRule(rules, name) !== undefined;
}

/** Arguments of a rule, or undefined when it is absent; `[]` when it has none. */
export function ruleArgs(rules: string[], name: string): string[] | undefined {
  const r = findRule(rules, name);
  if (r === undefined) return undefined;
  if (r === name) return [];
  return splitArgs(r.slice(name.length + 1, -1));
}

/** A numeric argument: `5`, `-1.5`, or a constant recorded with its value (`MAX_AMOUNT = 1000`). */
export function numArg(rules: string[], name: string, index = 0): number | undefined {
  const a = ruleArgs(rules, name)?.[index];
  const m = a === undefined ? null : /^(?:[\w.]+\s*=\s*)?(-?\d+(\.\d+)?)$/.exec(a);
  return m ? Number(m[1]) : undefined;
}

/** True when a rule is declared with `{ each: true }`, i.e. it applies to every array item. */
export function isEach(rule: string): boolean {
  return /\beach:\s*true\b/.test(rule);
}

/**
 * A JSON Schema `pattern` for `@Matches(...)`: regex and string forms; undefined when flags such as
 * `i` change the meaning (JSON Schema patterns cannot carry flags) or the text was cut short.
 */
export function matchesPattern(rules: string[]): string | undefined {
  const first = ruleArgs(rules, 'Matches')?.[0];
  if (!first || first.includes('…')) return undefined;
  const re = /^\/(.*)\/([a-z]*)$/.exec(first);
  if (re) return re[2].replace(/g/g, '') ? undefined : re[1];
  const str = /^'(.*)'$|^"(.*)"$/.exec(first);
  return str ? (str[1] ?? str[2]).replace(/\\\\/g, '\\') : undefined;
}

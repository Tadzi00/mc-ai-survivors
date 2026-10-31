/**
 * Robustly extracts the first JSON object from model text: handles ```json fences, prose before /
 * after, and braces inside strings. Returns undefined when nothing parseable is found.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    const v: unknown = JSON.parse(trimmed);
    if (v !== null && typeof v === 'object') return v;
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const inner = extractJsonObject(fence[1]);
    if (inner !== undefined) return inner;
  }
  for (let start = trimmed.indexOf('{'); start !== -1; start = trimmed.indexOf('{', start + 1)) {
    const end = findBalancedEnd(trimmed, start);
    if (end === -1) continue;
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(repairJson(candidate));
      } catch {
        /* try next brace */
      }
    }
  }
  return undefined;
}

function findBalancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Light-touch repairs for common small-model mistakes: trailing commas, single-quoted keys. */
function repairJson(s: string): string {
  return s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([A-Za-z_][\w]*)'\s*:/g, '$1"$2":');
}

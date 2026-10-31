/** Pure helpers to read book pages from prismarine items (1.20.5+ components or legacy NBT). */

/** Flattens a chat/text component given as JSON string, plain object, or prismarine-nbt tag. */
export function flattenText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('"') && t.endsWith('"')) || t.startsWith('[')) {
      try {
        return flattenText(JSON.parse(t) as unknown);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flattenText).join('');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // prismarine-nbt tag: {type, value}
    if ('type' in o && 'value' in o && Object.keys(o).length <= 3) {
      if (o.type === 'compound' || o.type === 'list') return flattenText(o.value);
      return flattenText(o.value);
    }
    // list tag value: {type, value: [...]}
    let out = '';
    if ('text' in o) out += flattenText(o.text);
    if ('' in o) out += flattenText(o['']);
    if ('extra' in o) out += flattenText(o.extra);
    return out;
  }
  return '';
}

export interface BookLike {
  componentMap?: Map<string, { data?: unknown }>;
  nbt?: unknown;
}

export interface BookContent {
  title?: string;
  author?: string;
  pages: string[];
}

export function readBookItem(item: BookLike): BookContent | undefined {
  const written = item.componentMap?.get('written_book_content')?.data as
    | { rawTitle?: string; author?: string; pages?: Array<{ content?: unknown }> }
    | undefined;
  if (written?.pages) {
    return { title: written.rawTitle, author: written.author, pages: written.pages.map((p) => flattenText(p.content)) };
  }
  const writable = item.componentMap?.get('writable_book_content')?.data as { pages?: Array<{ content?: unknown }> } | undefined;
  if (writable?.pages) return { pages: writable.pages.map((p) => flattenText(p.content)) };

  const nbt = item.nbt as { value?: Record<string, { value?: unknown }> } | undefined;
  const pagesTag = nbt?.value?.pages?.value as { value?: unknown[] } | undefined;
  if (pagesTag?.value) {
    return {
      title: typeof nbt?.value?.title?.value === 'string' ? (nbt.value.title.value as string) : undefined,
      author: typeof nbt?.value?.author?.value === 'string' ? (nbt.value.author.value as string) : undefined,
      pages: pagesTag.value.map(flattenText),
    };
  }
  return undefined;
}

/** Wraps text into at most `lines` lines of `width` chars for a sign (front side). */
export function wrapSignText(text: string, width = 15, lines = 4): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w0 of words) {
    let w = w0;
    while (w.length > width) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, lines);
}

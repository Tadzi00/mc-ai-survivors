// Finds what the bot already knows (books, signs, lessons, notes) that matches a question. PURE.

const STOP = new Set(['what', 'where', 'when', 'which', 'who', 'how', 'can', 'you', 'your', 'the', 'and', 'for', 'are', 'is', 'do', 'does', 'find', 'found', 'there', 'that', 'this', 'with', 'level', 'from', 'about', 'tell', 'know', 'have', 'any', 'some', 'please', 'question', 'written', 'book', 'answer']);

/** Lower-case word stems longer than 3 chars, without question/filler words. */
function keywords(t: string): string[] {
  return [...new Set(t.toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.replace(/(es|s)$/, '')))];
}

/**
 * The best matching snippets (max 2, ~160 chars each) for a question: each source scores by how many of
 * the question's keywords it contains. Sources with no keyword are skipped.
 */
export function relevantKnowledge(question: string, sources: Array<{ from: string; text: string }>): string[] {
  const keys = keywords(question);
  if (!keys.length) return [];
  return sources
    .map((s) => {
      const low = s.text.toLowerCase();
      return { s, score: keys.filter((k) => low.includes(k)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ s }) => `${s.from} says: "${s.text.replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
}

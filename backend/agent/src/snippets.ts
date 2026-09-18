/**
 * Choosing what a citation rests on. The snippet is a verbatim run of the page's own
 * sentences, so grounding is provable by string match rather than by trusting the model.
 */
const STOP = new Set(
  'the a an and or of to in on for with is are was were be been by as at from that this these those what which who how why when where does do did it its into than then there their about can could would should will your you we our not no'.split(' ')
);

export const terms = (q: string) =>
  [...new Set(q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];

/** Remove markup that is not in the rendered page: markdown links, bare URLs, table pipes. */
export function cleanText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[|#*_`>]{1,}/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

const splitSentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

function score(text: string, qTerms: string[]): number {
  const lower = text.toLowerCase();
  let s = 0;
  for (const t of qTerms) if (lower.includes(t)) s += 1;
  return s;
}

export interface Passage {
  /** What the model reads for this source. */
  context: string;
  /** Verbatim sentences from the page; what the citation rests on. */
  snippet: string;
  score: number;
}

/**
 * Window the page into ~maxChars passages, pick the one sharing the most query terms,
 * then pick the best run of 2-3 plain sentences inside it (>= 20 words) as the snippet.
 */
export function bestPassage(rawText: string, query: string, maxChars = 1600): Passage | null {
  const qTerms = terms(query);
  const sentences = splitSentences(cleanText(rawText)).filter((s) => wordCount(s) >= 4);
  if (!sentences.length) return null;

  const windows: { text: string; start: number; end: number }[] = [];
  for (let i = 0; i < sentences.length; ) {
    let j = i;
    let len = 0;
    while (j < sentences.length && (len === 0 || len + sentences[j]!.length < maxChars)) len += sentences[j++]!.length + 1;
    windows.push({ text: sentences.slice(i, j).join(' '), start: i, end: j });
    i = Math.max(i + 1, j - 1);
  }
  let best = windows[0]!;
  let bestScore = -1;
  for (const w of windows) {
    const s = score(w.text, qTerms);
    if (s > bestScore) [best, bestScore] = [w, s];
  }

  // Snippet: the highest-scoring run of up to 3 real prose sentences inside the window.
  // Headings, nav fragments and menu glyphs are what extracted page text repeats out of
  // order, so a snippet built from them may not appear verbatim on the rendered page.
  // Titles, FAQ headings, banners and anything the page repeats are the lines most likely to be
  // rendered differently (or not at all) in the page's HTML, so they never become a snippet.
  const seen = new Map<string, number>();
  for (const s of sentences) seen.set(s, (seen.get(s) ?? 0) + 1);
  const BOILERPLATE = /\b(cookies?|subscribe|sign in|log in|archived|no longer maintained|all rights reserved|cover image|click here|advertisement|newsletter)\b/i;
  const titleCase = (s: string) => {
    const words = s.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    return words.length > 0 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length > 0.5;
  };
  const prose = (s: string) =>
    !/[{}<>[\]\\↑↓↵|]/.test(s) &&
    /[.!]["')’”]?$/.test(s) &&
    wordCount(s) >= 8 &&
    /[a-z]{3}/.test(s) &&
    seen.get(s) === 1 &&
    !BOILERPLATE.test(s) &&
    !titleCase(s);
  const pick = (from: number, to: number) => {
    let snippetText = '';
    let snipScore = -1;
    for (let i = from; i < to; i++) {
      if (!prose(sentences[i]!)) continue;
      let run = sentences[i]!;
      let k = i + 1;
      // ~30 words gives the 12-token grounding match many windows: one odd character cannot sink it.
      while (wordCount(run) < 30 && k < to && k < i + 4 && prose(sentences[k]!)) run += ' ' + sentences[k++]!;
      if (wordCount(run) < 14) continue;
      const s = score(run, qTerms) * 10 + Math.min(wordCount(run), 40) / 10;
      if (s > snipScore) [snippetText, snipScore] = [run, s];
    }
    return snippetText;
  };
  let snippet = pick(best.start, best.end) || pick(0, sentences.length);
  if (!snippet) return null; // no citable prose on this page: the caller treats it as unreadable
  if (snippet.length > 500) snippet = snippet.slice(0, 500).replace(/\s+\S*$/, '');
  return { context: best.text, snippet, score: bestScore };
}

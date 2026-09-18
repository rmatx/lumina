/**
 * Parsing and chunking for the worker. Every chunk carries a locator: {page} for PDFs,
 * {heading, line} for Markdown and text, so a citation can say where it came from.
 */
export interface RawChunk {
  text: string;
  locator: { page?: number; heading?: string; line?: number };
}

const TARGET = 900;
const OVERLAP = 150;

function windowText(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= TARGET) return clean ? [clean] : [];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + TARGET);
    if (end < clean.length) {
      // Prefer to end on a sentence or line boundary.
      const cut = Math.max(clean.lastIndexOf('. ', end), clean.lastIndexOf('\n', end));
      if (cut > start + TARGET / 2) end = cut + 1;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP, start + 1);
    // Start on a word boundary.
    const sp = clean.indexOf(' ', start);
    if (sp > -1 && sp < end) start = sp + 1;
  }
  return out.filter((c) => c.length > 20);
}

export async function parsePdf(buf: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    pages.push(text);
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

export function chunkPdfPages(pages: string[]): RawChunk[] {
  return pages.flatMap((text, i) => windowText(text).map((t) => ({ text: t, locator: { page: i + 1 } })));
}

/** Markdown / text: split into heading sections, then window each section. Line = section start. */
export function chunkText(source: string, fallbackHeading: string): RawChunk[] {
  const lines = source.split('\n');
  const sections: { heading: string; line: number; body: string[] }[] = [];
  let cur = { heading: fallbackHeading, line: 1, body: [] as string[] };
  lines.forEach((l, i) => {
    const m = /^#{1,6}\s+(.*)$/.exec(l);
    if (m) {
      if (cur.body.join('').trim()) sections.push(cur);
      cur = { heading: m[1]!.trim(), line: i + 1, body: [] };
    } else cur.body.push(l);
  });
  if (cur.body.join('').trim()) sections.push(cur);

  return sections.flatMap((s) =>
    windowText(s.body.join('\n')).map((t, j) => ({
      text: `${s.heading}\n${t}`,
      // Distinct line per window so two chunks of one section never share a locator.
      locator: { heading: s.heading, line: s.line + j }
    }))
  );
}

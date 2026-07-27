// Normalizes raw text extracted from PDF/DOCX/PPTX before it's shown for
// review or saved as topic content (roadmap #11). pdf-parse in particular
// carries through real per-page artifacts — repeated headers/footers, runs
// of blank lines, and hyphenated line-wrap breaks — that cost tokens with
// zero information value. Pure token savings, no quality tradeoff: unlike
// converting to markdown (considered and rejected), none of the three
// extraction paths produce markup to begin with, so there's no markup tax
// to compress away here — just artifact cleanup.

// A header/footer line repeats verbatim on enough pages to show up several
// times, and is short (a title, page number, date) — a long line repeating
// this often is far more likely to be a genuinely repeated sentence than a
// running header, so length caps which lines are eligible for stripping.
const MIN_REPEATS_TO_STRIP = 3;
const MAX_HEADER_FOOTER_LEN = 100;

// Joins a word broken across a line-wrap ("informa-\ntion" -> "information").
// Lowercase on both sides of the hyphen distinguishes a genuine mid-word
// wrap from a hyphenated compound that coincidentally falls at a line end.
function dehyphenate(text) {
  return text.replace(/([a-z])-\n([a-z])/g, '$1$2');
}

function stripRepeatedLines(text) {
  const lines = text.split('\n');
  const counts = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > MAX_HEADER_FOOTER_LEN) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }
  return lines
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true; // blank-line collapsing happens separately
      return (counts.get(trimmed) || 0) < MIN_REPEATS_TO_STRIP;
    })
    .join('\n');
}

function collapseWhitespace(text) {
  return text
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeExtractedText(text) {
  if (!text) return text;
  let out = text.replace(/\r\n/g, '\n');
  out = dehyphenate(out);
  out = stripRepeatedLines(out);
  out = collapseWhitespace(out);
  return out;
}

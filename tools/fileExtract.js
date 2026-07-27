// Structure-aware PPTX/DOCX text extraction.
//
// The old approach flattened every text run on a slide/page into one blob,
// discarding structural metadata the file formats already carry for free —
// which shape is the slide title vs its body, which paragraph is a heading
// vs regular text, which table cells pair up as term/definition. Recovering
// that structure means downstream local extraction (tools/localExtract.js)
// gets clean "Term: definition" lines with zero guessing and zero API calls,
// instead of relying on regex heuristics to reverse-engineer meaning out of
// unstructured prose.
//
// Every path here falls back to flattening (the old behavior) for anything
// that doesn't fit a recognized shape — nothing is dropped, only enriched
// when the source format actually contains recoverable structure.

import AdmZip from 'adm-zip';
import mammoth from 'mammoth';

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// localExtract.js's sentence splitter collapses all whitespace (including
// newlines) before splitting on terminal punctuation — so any stretch of
// synthesized lines with no period anywhere (PPTX bullets/titles very often
// have none) gets fused into one giant "sentence." Every line emitted here
// needs its own terminal punctuation so each one reads as a real, separate
// sentence downstream, regardless of whether the source content had any.
function terminate(line) {
  const trimmed = line.trim();
  if (!trimmed) return trimmed;
  return /[.?!]$/.test(trimmed) ? trimmed : trimmed + '.';
}

// ── PPTX ──────────────────────────────────────────────────────────────────────

const TITLE_PH_TYPES = new Set(['title', 'ctrTitle']);

function shapeText(shapeXml) {
  return [...shapeXml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' ').trim();
}

// One slide's raw XML in, one slide's worth of synthesized text out.
export function synthesizePptxSlide(xml) {
  const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(m => m[0]);
  let titleText = null;
  // roadmap #9 — a slide with two title-placeholder shapes (not something a
  // standard PowerPoint layout produces, but seen in the wild) used to fold
  // the second title straight into otherTexts, indistinguishable from real
  // body content once joined into the "Term: definition" line. Keep any
  // extra title shapes separate so they surface as their own line instead.
  const extraTitleTexts = [];
  const otherTexts = [];

  for (const sp of shapes) {
    const phType = /<p:ph\s+type="([^"]+)"/.exec(sp)?.[1];
    const text = shapeText(sp);
    if (!text) continue;
    if (phType && TITLE_PH_TYPES.has(phType)) {
      if (titleText === null) titleText = text;
      else extraTitleTexts.push(text);
    } else {
      otherTexts.push(text);
    }
  }

  // Tables live in <p:graphicFrame><a:tbl>, a sibling shape type to <p:sp> —
  // a walk that only checked <p:sp> would silently drop every table on the
  // slide, which today's flat regex at least captures (unstructured).
  const tableLines = [];
  const fallbackTableTexts = [];
  const tables = [...xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)].map(m => m[0]);
  for (const tbl of tables) {
    const rows = [...tbl.matchAll(/<a:tr[^>]*>[\s\S]*?<\/a:tr>/g)].map(m => m[0]);
    for (const row of rows) {
      const cells = [...row.matchAll(/<a:tc[^>]*>[\s\S]*?<\/a:tc>/g)]
        .map(cell => shapeText(cell[0]))
        .filter(Boolean);
      if (cells.length === 2) {
        tableLines.push(`${cells[0]}: ${cells[1]}`);
      } else if (cells.length) {
        // Not a clean 2-column term/definition table — keep the text
        // (parity with today), just don't force a glossary shape onto it.
        fallbackTableTexts.push(cells.join(' '));
      }
    }
  }

  const lines = [];
  if (titleText && otherTexts.length) {
    lines.push(`${titleText}: ${otherTexts.join(' ')}`);
  } else if (titleText) {
    lines.push(titleText);
  } else {
    lines.push(...otherTexts);
  }
  lines.push(...extraTitleTexts, ...tableLines, ...fallbackTableTexts);

  if (!lines.length) {
    // Nothing recognized (image-only slide, freeform/unsupported shapes) —
    // flatten whatever text exists at all, matching pre-fix behavior exactly
    // so this can only ever add structure, never lose content.
    const flat = shapeText(xml);
    if (flat) lines.push(flat);
  }

  return lines.map(terminate).join('\n');
}

export function extractPptxText(buffer) {
  const zip = new AdmZip(buffer);
  const slides = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

  return slides
    .map(slide => synthesizePptxSlide(slide.getData().toString('utf-8')))
    .join('\n\n');
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

// mammoth.convertToHtml() emits a flat sequence of sibling block elements
// (h1-h6, p, table, ul/ol) in document order — walk that sequence, treating
// each heading as a term and everything until the next heading as its
// definition. A document with no headings at all degenerates to one line
// per paragraph, matching the old extractRawText() behavior.
export function synthesizeDocxHtml(html) {
  const blocks = [...html.matchAll(/<(h[1-6]|p|table|ul|ol)[^>]*>[\s\S]*?<\/\1>/g)];
  const lines = [];
  let pendingTerm = null;
  let pendingBody = [];

  function flush() {
    if (pendingTerm && pendingBody.length) {
      lines.push(`${pendingTerm}: ${pendingBody.join(' ')}`);
    } else if (pendingTerm) {
      lines.push(pendingTerm);
    } else if (pendingBody.length) {
      lines.push(...pendingBody);
    }
    pendingTerm = null;
    pendingBody = [];
  }

  for (const block of blocks) {
    const [full, tag] = block;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      pendingTerm = stripTags(full);
    } else if (tag === 'p') {
      const text = stripTags(full);
      if (text) pendingBody.push(text);
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...full.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map(m => stripTags(m[0])).filter(Boolean);
      pendingBody.push(...items);
    } else if (tag === 'table') {
      // A table mid-document must not jump ahead of a still-pending
      // heading/paragraph pair — commit whatever's pending first so lines
      // come out in the same order the document actually reads.
      flush();
      const rows = [...full.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]);
      for (const row of rows) {
        const cells = [...row.matchAll(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g)].map(m => stripTags(m[0])).filter(Boolean);
        if (cells.length === 2) lines.push(`${cells[0]}: ${cells[1]}`);
        else if (cells.length) pendingBody.push(cells.join(' '));
      }
    }
  }
  flush();

  return lines.map(terminate).join('\n');
}

export async function extractDocxText(buffer) {
  const result = await mammoth.convertToHtml({ buffer });
  return synthesizeDocxHtml(result.value);
}

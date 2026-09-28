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

// A body shape whose bullets are indented under one another (term at level
// 0, its definition as level-1+ sub-bullets) → one "Term: definition" line
// per top-level bullet. Returns null when the shape has no such nesting, so
// flat bodies keep the joined-text behavior.
function shapeOutline(shapeXml) {
  const paras = [...shapeXml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)]
    .map(m => ({ lvl: Number(/<a:pPr\b[^>]*\blvl="(\d+)"/.exec(m[0])?.[1] ?? 0), text: shapeText(m[0]) }))
    .filter(p => p.text);
  if (!paras.length) return null;
  const top = Math.min(...paras.map(p => p.lvl));
  if (paras[0].lvl !== top || !paras.some(p => p.lvl > top)) return null;

  const entries = [];
  for (const p of paras) {
    if (p.lvl === top) entries.push({ own: p.text, kids: [] });
    else entries[entries.length - 1].kids.push(p.text);
  }
  return entries.map(e => (e.kids.length ? `${e.own.replace(/:$/, '')}: ${e.kids.join('; ')}` : e.own));
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
  const outlineLines = [];

  for (const sp of shapes) {
    const phType = /<p:ph\s+type="([^"]+)"/.exec(sp)?.[1];
    const text = shapeText(sp);
    if (!text) continue;
    if (phType && TITLE_PH_TYPES.has(phType)) {
      if (titleText === null) titleText = text;
      else extraTitleTexts.push(text);
    } else {
      const outline = shapeOutline(sp);
      if (outline) outlineLines.push(...outline);
      else otherTexts.push(text);
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
  lines.push(...outlineLines, ...extraTitleTexts, ...tableLines, ...fallbackTableTexts);

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

// Top-level elements matching `tagRe` inside `html`, nesting-aware. A lazy
// `<ul>[\s\S]*?</ul>` regex stops at the first *inner* `</ul>`, which on a
// nested list (the usual "bold term, sub-bullets for its definition" study
// guide) silently dropped every term after the first.
function topLevelElements(html, tagRe) {
  const out = [];
  const openRe = new RegExp(`<(${tagRe})\\b[^>]*>`, 'g');
  let open;
  while ((open = openRe.exec(html))) {
    const tag = open[1];
    const tokenRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    tokenRe.lastIndex = open.index + open[0].length;
    let depth = 1;
    let tok;
    while (depth && (tok = tokenRe.exec(html))) depth += tok[1] ? -1 : 1;
    const end = tok ? tok.index + tok[0].length : html.length;
    out.push({ tag, full: html.slice(open.index, end), inner: html.slice(open.index + open[0].length, tok ? tok.index : end) });
    openRe.lastIndex = end;
  }
  return out;
}

// One <li>'s own text (nested lists removed) plus its sub-items, each sub-item
// itself flattened with any deeper levels folded in. A sub-item that is a
// bold-only label with sub-bullets of its own ("Ancient Egypt" → "Ba soul" →
// its definition) is a nested term, not part of the parent's definition — it
// comes back separately in `subTerms` so it gets its own line.
function listItemParts(liInner) {
  const nested = topLevelElements(liInner, 'ul|ol');
  let own = liInner;
  for (const n of nested) own = own.replace(n.full, ' ');
  const children = [];
  const subTerms = [];
  for (const li of nested.flatMap(n => topLevelElements(n.inner, 'li'))) {
    const parts = listItemParts(li.inner);
    if (parts.children.length && parts.boldOnly) subTerms.push(...termLines(parts));
    else children.push(flattenListItem(parts));
  }
  return {
    own: stripTags(own),
    // "Three parts:" (trailing colon) introduces its sub-bullets as part of
    // the parent's definition — only a bare bold label names a new term.
    boldOnly: /^\s*<(strong|b)>[\s\S]*?<\/\1>\s*$/.test(own) && !/:$/.test(stripTags(own)),
    pair: boldLeadPair(own),
    children: children.filter(Boolean),
    subTerms
  };
}

// A list item as "Term: child; child" plus any nested-term lines after it.
function termLines(parts) {
  return [flattenListItem(parts), ...parts.subTerms].filter(Boolean);
}

// "<strong>Term</strong>: definition" / "<strong>Term:</strong> definition" /
// "<strong>Term</strong> – definition" — the other common way a study guide
// marks a term inline. Needs an explicit separator so an ordinary sentence
// that merely opens in bold ("<strong>Born</strong> in Phthia") isn't split.
const LEAD_SEP = '[:–—-]';
function boldLeadPair(innerHtml) {
  const m = /^\s*<(strong|b)>([\s\S]*?)<\/\1>([\s\S]*)$/.exec(innerHtml);
  if (!m) return null;
  let term = stripTags(m[2]);
  let rest = stripTags(m[3]);
  if (new RegExp(`${LEAD_SEP}$`).test(term)) term = term.replace(new RegExp(`\\s*${LEAD_SEP}$`), '');
  else if (new RegExp(`^${LEAD_SEP}`).test(rest)) rest = rest.replace(new RegExp(`^${LEAD_SEP}\\s*`), '');
  else return null;
  return term && rest ? `${term}: ${rest}` : null;
}

function flattenListItem({ own, children }) {
  if (!children.length) return own;
  return `${own.replace(/:$/, '')}: ${children.join('; ')}`;
}

// mammoth.convertToHtml() emits a flat sequence of sibling block elements
// (h1-h6, p, table, ul/ol) in document order — walk that sequence, treating
// each heading as a term and everything until the next heading as its
// definition. A document with no headings at all degenerates to one line
// per paragraph, matching the old extractRawText() behavior.
export function synthesizeDocxHtml(html) {
  const blocks = topLevelElements(html, 'h[1-6]|p|table|ul|ol').map(b => [b.full, b.tag, b.inner]);
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
    const [full, tag, inner] = block;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      pendingTerm = stripTags(full);
    } else if (tag === 'p') {
      const pair = boldLeadPair(inner);
      if (pair) {
        flush();
        lines.push(pair);
      } else {
        const text = stripTags(full);
        if (text) pendingBody.push(text);
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const items = topLevelElements(inner, 'li').map(li => listItemParts(li.inner));
      if (items.some(it => it.children.length || it.subTerms.length || it.pair)) {
        // Bullets with sub-bullets, or bold-term bullets, = a glossary in
        // list form: each term gets its own "Term: definition" line.
        flush();
        for (const it of items) {
          if (it.pair && !it.children.length) lines.push(it.pair, ...it.subTerms);
          else lines.push(...termLines(it));
        }
      } else {
        pendingBody.push(...items.map(it => it.own).filter(Boolean));
      }
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

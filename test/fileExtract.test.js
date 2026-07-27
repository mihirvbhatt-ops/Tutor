// Unit + round-trip tests for structure-aware PPTX/DOCX extraction
// (tools/fileExtract.js). Recovers "Term: definition" shape directly from
// slide title/body placeholders, table cells, and DOCX heading styles —
// zero API calls, zero heuristics, just reading structure the file formats
// already carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {
  synthesizePptxSlide, extractPptxText,
  synthesizeDocxHtml, extractDocxText
} from '../tools/fileExtract.js';

// ── PPTX: synthesizePptxSlide (pure, single-slide XML in) ───────────────────

function titleBodySlideXml(title, bodyLines) {
  const bodyParas = bodyLines.map(l => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('');
  return `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:txBody>${bodyParas}</p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
}

test('synthesizePptxSlide joins title + body placeholders into a "Term: definition" line', () => {
  const xml = titleBodySlideXml('Achilles', ['Greatest Greek warrior', 'Nearly invincible except for his heel']);
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Achilles: Greatest Greek warrior Nearly invincible except for his heel.');
});

test('synthesizePptxSlide keeps a title-only slide as plain text, no forced colon', () => {
  const xml = titleBodySlideXml('Part II: The Fall of Troy', []);
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Part II: The Fall of Troy.');
});

test('synthesizePptxSlide handles multiple non-title shapes ("two content" layout) by concatenating them all as the definition', () => {
  const xml = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Greek vs Trojan Forces</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Led by Agamemnon</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Led by Priam</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Greek vs Trojan Forces: Led by Agamemnon Led by Priam.');
});

function tableSlideXml(rows) {
  const trs = rows.map(cells =>
    `<a:tr>${cells.map(c => `<a:tc><a:txBody><a:p><a:r><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`
  ).join('');
  return `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
      <p:graphicFrame><a:graphic><a:graphicData><a:tbl>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
    </p:spTree></p:cSld></p:sld>`;
}

test('synthesizePptxSlide turns a 2-column table into "Term: definition" lines per row', () => {
  const xml = tableSlideXml([['Achilles', 'Greatest Greek warrior'], ['Hector', 'Greatest Trojan warrior']]);
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Achilles: Greatest Greek warrior.\nHector: Greatest Trojan warrior.');
});

test('synthesizePptxSlide keeps a non-2-column table as flattened text instead of forcing a wrong glossary shape', () => {
  const xml = tableSlideXml([['Achilles', 'Greek', 'Warrior']]);
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Achilles Greek Warrior.');
});

test('synthesizePptxSlide falls back to flattening when nothing is recognized (e.g. image-only slide)', () => {
  // A caption text box with no <p:ph> type at all — no title, no table.
  const xml = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Figure 1: Map of the Aegean</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Figure 1: Map of the Aegean.');
});

// roadmap #9 — a slide with two shapes both marked as a title placeholder
// (not something a standard layout produces, but seen in the wild) used to
// fold the second title straight into the body/definition text. It should
// come out as its own line instead.
test('synthesizePptxSlide keeps a second title-placeholder shape as its own line instead of folding it into the definition', () => {
  const xml = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Achilles</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Greatest Greek Warrior</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Nearly invincible except for his heel</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
  const out = synthesizePptxSlide(xml);
  assert.equal(out, 'Achilles: Nearly invincible except for his heel.\nGreatest Greek Warrior.');
});

test('synthesizePptxSlide returns empty string for a slide with no extractable text (pure image)', () => {
  const xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>`;
  assert.equal(synthesizePptxSlide(xml), '');
});

// ── PPTX: extractPptxText (full buffer → AdmZip → slides) ───────────────────

test('extractPptxText walks slides in numeric order and joins them with a blank line', () => {
  const zip = new AdmZip();
  zip.addFile('ppt/slides/slide2.xml', Buffer.from(titleBodySlideXml('Hector', ['Trojan warrior'])));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(titleBodySlideXml('Achilles', ['Greek warrior'])));
  zip.addFile('ppt/slides/slide10.xml', Buffer.from(titleBodySlideXml('Epilogue', ['The war ends'])));
  const text = extractPptxText(zip.toBuffer());
  assert.equal(text, 'Achilles: Greek warrior.\n\nHector: Trojan warrior.\n\nEpilogue: The war ends.');
});

// ── DOCX: synthesizeDocxHtml (pure, mammoth HTML output in) ─────────────────

test('synthesizeDocxHtml pairs a heading with its following paragraph(s) into "Term: definition"', () => {
  const html = '<h1>Achilles</h1><p>Greatest Greek warrior,</p><p>nearly invincible except for his heel.</p><h1>Hector</h1><p>Greatest Trojan warrior.</p>';
  const out = synthesizeDocxHtml(html);
  assert.equal(out, 'Achilles: Greatest Greek warrior, nearly invincible except for his heel.\nHector: Greatest Trojan warrior.');
});

test('synthesizeDocxHtml treats bullet-list items after a heading as body content', () => {
  const html = '<h1>Achilles</h1><ul><li>Greatest Greek warrior</li><li>Nearly invincible except for his heel</li></ul>';
  const out = synthesizeDocxHtml(html);
  assert.equal(out, 'Achilles: Greatest Greek warrior Nearly invincible except for his heel.');
});

test('synthesizeDocxHtml keeps document order when a table sits between two heading+paragraph pairs', () => {
  const html =
    '<h1>Overview</h1><p>Intro text.</p>' +
    '<table><tr><td>Glycolysis</td><td>Breakdown of glucose</td></tr></table>' +
    '<h1>Anaerobic Respiration</h1><p>Happens without oxygen.</p>';
  const out = synthesizeDocxHtml(html);
  assert.equal(
    out,
    'Overview: Intro text.\nGlycolysis: Breakdown of glucose.\nAnaerobic Respiration: Happens without oxygen.'
  );
});

test('synthesizeDocxHtml turns a 2-column table into "Term: definition" lines', () => {
  const html = '<table><tr><td>Achilles</td><td>Greatest Greek warrior</td></tr><tr><td>Hector</td><td>Greatest Trojan warrior</td></tr></table>';
  const out = synthesizeDocxHtml(html);
  assert.equal(out, 'Achilles: Greatest Greek warrior.\nHector: Greatest Trojan warrior.');
});

test('synthesizeDocxHtml with no headings at all degenerates to one line per paragraph', () => {
  const html = '<p>The Trojan War was a legendary conflict.</p><p>It lasted ten years.</p>';
  const out = synthesizeDocxHtml(html);
  assert.equal(out, 'The Trojan War was a legendary conflict.\nIt lasted ten years.');
});

test('synthesizeDocxHtml keeps a heading with no following body as plain text, no forced colon', () => {
  const html = '<h1>Part II: The Fall of Troy</h1><h1>Achilles</h1><p>Greatest Greek warrior.</p>';
  const out = synthesizeDocxHtml(html);
  assert.equal(out, 'Part II: The Fall of Troy.\nAchilles: Greatest Greek warrior.');
});

// ── DOCX: extractDocxText (full buffer → mammoth → synthesize) ──────────────

function buildMinimalDocx(bodyXml) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
     <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
     <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
     <Default Extension="xml" ContentType="application/xml"/>
     <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
     </Types>`
  ));
  zip.addFile('_rels/.rels', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
     <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
     </Relationships>`
  ));
  zip.addFile('word/document.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
     <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
  ));
  return zip.toBuffer();
}

test('extractDocxText round-trips a real minimal docx through mammoth into "Term: definition" lines', async () => {
  const body = `
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Achilles</w:t></w:r></w:p>
    <w:p><w:r><w:t>Greatest Greek warrior, nearly invincible except for his heel.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hector</w:t></w:r></w:p>
    <w:p><w:r><w:t>Greatest Trojan warrior and eldest son of King Priam.</w:t></w:r></w:p>
  `;
  const text = await extractDocxText(buildMinimalDocx(body));
  assert.equal(
    text,
    'Achilles: Greatest Greek warrior, nearly invincible except for his heel.\nHector: Greatest Trojan warrior and eldest son of King Priam.'
  );
});

// ── LIBRARY ───────────────────────────────────────────────────────────────────

function hashNum(str, seed = 0) {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Spine colour ─────────────────────────────────────────────────────────
// Five curated covers. Colour and texture are a single paired unit now —
// not picked independently — so every "navy blue" book is always matte
// leather, every "emerald green" book is always the metallic finish, etc.
const COVER_COLORS = [
  { key: 'navy',    hue: 214, sat: 55, light: 22, finish: 'finish-matte'    },
  { key: 'velvet',  hue: 355, sat: 68, light: 26, finish: 'finish-velvet'   },
  { key: 'magenta', hue: 320, sat: 55, light: 24, finish: 'finish-matte'    },
  { key: 'emerald', hue: 152, sat: 58, light: 32, finish: 'finish-metallic' },
  { key: 'crimson', hue: 348, sat: 70, light: 34, finish: 'finish-matte'    },
];
function pickCoverColor(name) {
  return COVER_COLORS[hashNum(name, 3) % COVER_COLORS.length];
}

// Flat fill for the spine's own colour — no gradient. The finish- classes in
// CSS layer the actual leather/velvet/metallic texture on top of this.
function baseGradientLayer(bc) {
  return bc;
}

// ── Trim (metallic band) colour ──────────────────────────────────────────
// Every trim, whichever of the three layouts below it's drawn in, is either
// gold or silver — picked once per book so its band(s) and its title text
// (see applySpineStyle) always match. Each band is a single flat colour —
// no internal light/dark gradient — so it never reads as two different
// colours stacked together, especially on the large asymmetric band where
// that was most visible.
function trimIsGold(name) {
  return hashNum(name, 160) % 2 === 0;
}
function trimColor(gold) {
  return gold ? 'hsl(43 78% 50%)' : 'hsl(210 10% 66%)';
}

// A single (un-mirrored), flat-coloured band at one edge.
function metallicBandAt(edge, margin, width, gold) {
  const color = trimColor(gold);
  const end = margin + width;
  if (edge === 'bottom') {
    return `linear-gradient(180deg,
      transparent 0%, transparent ${100 - end}%,
      ${color} ${100 - end}%, ${color} ${100 - margin}%,
      transparent ${100 - margin}%, transparent 100%)`;
  }
  return `linear-gradient(180deg,
    transparent 0%, transparent ${margin}%,
    ${color} ${margin}%, ${color} ${end}%,
    transparent ${end}%, transparent 100%)`;
}

// ── Trim layout ───────────────────────────────────────────────────────────
// Three kinds, picked per-title: 'asymmetric' is one band near the top only
// (nothing at the bottom — the name sits right underneath it rather than
// centred or dropped to the base); 'two-end' is a matched trim at both top
// and bottom (name stays centred); 'double' also trims both ends, but the
// top one is drawn a little longer than usual and the bottom one fairly
// shorter (name still centred, just clears whichever end is bigger).
const TRIM_TYPES = ['asymmetric', 'two-end', 'double'];
function pickTrimType(name) {
  return TRIM_TYPES[hashNum(name, 110) % TRIM_TYPES.length];
}

const TRIM_MARGIN      = 8;
const TRIM_WIDTH       = 7;   // 'two-end' — same size both ends
const TRIM_LONG_WIDTH  = 11;  // 'double' — top
const TRIM_SHORT_WIDTH = 4;   // 'double' — bottom
const ASYM_MARGIN = 6;
const ASYM_WIDTH  = 19;

// Builds the full `--spine-base` gradient stack for one book: the trim
// band(s) for `trimType` over the spine's own flat colour. Also returns
// `justify` (how the title should sit in the box — see applySpineStyle),
// `titleOffsetPct` (for 'asymmetric' only — how far down, as a % of the
// book's height, the title needs to start to clear the band) and
// `titleClear` (the %-of-height the title may occupy without running into
// a band).
function buildSpineLayers(bc, trimType, gold) {
  const base = baseGradientLayer(bc);

  if (trimType === 'asymmetric') {
    const layers = [
      metallicBandAt('top', ASYM_MARGIN, ASYM_WIDTH, gold),
      base,
    ];
    const bandEnd = ASYM_MARGIN + ASYM_WIDTH;
    const belowBand = 100 - bandEnd;
    return {
      spineBase: layers.join(', '),
      justify: 'flex-start',
      titleOffsetPct: bandEnd + 3,
      titleClear: Math.max(belowBand - 6, 20),
    };
  }

  const topWidth    = trimType === 'double' ? TRIM_LONG_WIDTH  : TRIM_WIDTH;
  const bottomWidth = trimType === 'double' ? TRIM_SHORT_WIDTH : TRIM_WIDTH;
  const layers = [
    metallicBandAt('top', TRIM_MARGIN, topWidth, gold),
    metallicBandAt('bottom', TRIM_MARGIN, bottomWidth, gold),
    base,
  ];
  const largerClear = TRIM_MARGIN + Math.max(topWidth, bottomWidth);
  return {
    spineBase: layers.join(', '),
    justify: 'center',
    titleOffsetPct: 0,
    titleClear: Math.max(100 - 2 * (largerClear + 3), 20),
  };
}

// Splits a title into up to two lines the spine will actually render: for
// multi-word titles, roughly half the words per line (used by
// setSpineTitle() below); for a single word long enough that one line
// wouldn't be reasonable, splits the word itself in half with a hyphen
// instead of leaving one huge unbroken run. Short titles come back as a
// single line, unchanged.
function splitTitleLines(name) {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }
  if (trimmed.length > 10) {
    const mid = Math.ceil(trimmed.length / 2);
    return [trimmed.slice(0, mid) + '-', trimmed.slice(mid)];
  }
  return [trimmed];
}

// The length (in characters) of the longer of a title's rendered lines —
// used to grow the book (and, as a last resort, shrink its font) for
// titles that need more room, without affecting titles that fit as-is.
function longestTitleLine(name) {
  return Math.max(...splitTitleLines(name).map(line => line.length));
}

// Empirical vertical space one character needs at a given font size once
// stacked in the spine's vertical writing mode (measured against actual
// rendered title heights — noticeably less than a full em per character).
const CHAR_HEIGHT_RATIO = 0.7;
const DEFAULT_FONT_PX   = 8;
const MIN_FONT_PX       = 5.5;

// Shared by bookStyle()/courseStyle(): the spine's colour, trim, and title
// placement, plus its height/width, all derived from per-title hash seeds
// so a given book always renders identically. Height is driven by title
// length (see longestTitleLine): short titles stay at the baseline (plus a
// touch of jitter so the shelf isn't perfectly uniform); longer ones grow
// the book just enough for the longer line to fit at the default font size,
// capped so one very long title can't blow out the shelf row — past that
// cap, the font itself shrinks (down to a floor) as a last resort before
// falling back to the CSS ellipsis.
function computeSpineStyle(name, { heightBase, widthBase, widthSpan }) {
  const color = pickCoverColor(name);
  const bc    = `hsl(${color.hue} ${color.sat}% ${color.light}%)`;

  const trimType = pickTrimType(name);
  const gold     = trimIsGold(name);
  const { spineBase, justify, titleClear, titleOffsetPct } = buildSpineLayers(bc, trimType, gold);

  const jitter  = hashNum(name, 7) % 7;
  const longest = longestTitleLine(name);
  const requiredAvailablePx = longest * DEFAULT_FONT_PX * CHAR_HEIGHT_RATIO + 4;
  const requiredHeight      = Math.ceil(requiredAvailablePx / (titleClear / 100));
  const height = Math.min(Math.max(heightBase + jitter, requiredHeight), heightBase + 90);

  const availablePx = height * (titleClear / 100);
  const fitFontPx   = (availablePx - 4) / (longest * CHAR_HEIGHT_RATIO);
  const fontSize    = Math.min(DEFAULT_FONT_PX, Math.max(MIN_FONT_PX, fitFontPx));

  // Percentage margins/padding on a physical top/bottom property resolve
  // against the containing block's *width*, not its height (a long-standing
  // CSS quirk that writing-mode doesn't change) — so titleOffsetPct has to
  // be converted to an actual pixel offset here, against this book's own
  // height, rather than passed through as a CSS percentage.
  const titleOffsetPx = Math.round(height * (titleOffsetPct / 100));

  return {
    finish: color.finish,
    spineBase,
    justify,
    titleClear,
    titleOffsetPx,
    gold,
    fontSize,
    height,
    width: Math.round(widthBase + (hashNum(name, 13) % widthSpan)),
  };
}

function bookStyle(name) {
  return computeSpineStyle(name, { heightBase: 64, widthBase: 19, widthSpan: 22 });
}
// Slightly taller/wider baseline — course spines are drawn more prominent.
function courseStyle(name) {
  return computeSpineStyle(name, { heightBase: 72, widthBase: 26, widthSpan: 18 });
}

// A handful of distinct title treatments — serif, bold sans, small-caps
// serif, monospace — picked per-title (own hash seed) so spines don't all
// read in the same typeface.
const SPINE_FONTS = [
  { family: `Georgia,'Times New Roman',serif`,                  weight: 700, spacing: '.02em' },
  { family: `'Trebuchet MS',ui-sans-serif,system-ui,sans-serif`, weight: 800, spacing: '-.01em' },
  { family: `Georgia,serif`,                                    weight: 600, spacing: '.1em', variant: 'small-caps' },
  { family: `ui-monospace,'Courier New',monospace`,              weight: 700, spacing: '0' },
];
function spineFont(name) {
  return SPINE_FONTS[hashNum(name, 70) % SPINE_FONTS.length];
}

// Renders a title as up to two lines (see splitTitleLines()) instead of one
// long vertical column.
function setSpineTitle(span, name) {
  const lines = splitTitleLines(name);
  if (lines.length < 2) {
    span.textContent = lines[0];
    return;
  }
  span.replaceChildren(
    document.createTextNode(lines[0]),
    document.createElement('br'),
    document.createTextNode(lines[1]),
  );
}

// Applies a computeSpineStyle() result's finish class plus spineFont() to a
// freshly-created book element and its title span — shared by both the
// topic and course book loops. `justify` positions the title (centred, or
// — for an asymmetric top trim — pinned right under the band via
// `titleOffsetPx` rather than dropped to the base); the title colour always
// matches the book's own trim (gold or silver); `fontSize` is only ever
// below the 8px default for a title too long to fit even at max book
// height, per computeSpineStyle().
function applySpineStyle(book, span, name, style) {
  book.classList.add(style.finish);
  book.style.justifyContent = style.justify;
  span.style.maxHeight = style.titleClear + '%';
  span.style.marginTop = style.titleOffsetPx + 'px';
  span.style.fontSize  = style.fontSize + 'px';
  span.style.color = style.gold ? 'hsl(46 90% 66%)' : 'hsl(210 14% 90%)';
  const font = spineFont(name);
  span.style.fontFamily     = font.family;
  span.style.fontWeight     = font.weight;
  span.style.letterSpacing  = font.spacing;
  span.style.fontVariant    = font.variant || 'normal';
}

// Bookcases always show this many shelf rows, whether or not there are
// enough books to fill them — real shelving doesn't disappear when it's
// empty. More are added automatically if there's enough content to need them.
const MIN_SHELVES = 5;

// Appends empty shelf rows (no books) to `wrap` until it holds at least
// `min` shelves total — used so the permanent baseline of shelving still
// shows even when there's little or no content yet.
function padToMinShelves(wrap, min) {
  while (wrap.querySelectorAll(':scope > .shelf').length < min) {
    const s = document.createElement('div');
    s.className = 'shelf';
    wrap.appendChild(s);
  }
}

// Matches the .shelf CSS fallback — smallest a row can be without a
// max-height book (80–82px, see bookStyle()/courseStyle()) stretching it.
const SHELF_MIN_H = 96;

// Divides the bookcase's available height evenly across its shelf rows so
// they stay equally spaced AND the lowest one always sits flush on the
// floor, instead of leaving dead case space below it (or, if there's more
// content than fits, letting the bookcase scroll internally — see the
// `overflow-y:auto` fallback on .bookcase).
function layoutShelves(bcEl, wrap) {
  const shelves = wrap.querySelectorAll(':scope > .shelf');
  if (!bcEl || !shelves.length) return;
  const wrapStyle = getComputedStyle(wrap);
  const wrapPad = parseFloat(wrapStyle.paddingTop) + parseFloat(wrapStyle.paddingBottom);
  const each = Math.max(SHELF_MIN_H, Math.floor((bcEl.clientHeight - wrapPad) / shelves.length));
  shelves.forEach(s => { s.style.height = each + 'px'; });
}


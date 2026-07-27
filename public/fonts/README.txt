HOW TO ADD CUSTOM FONTS
═══════════════════════

Drop any font file into this folder and restart the server.
The font will appear automatically in Settings → Font family.

Supported formats:
  .woff2   (recommended — best compression, modern browsers)
  .woff    (good fallback)
  .ttf     (TrueType — works everywhere)
  .otf     (OpenType — works everywhere)

NAMING CONVENTION
─────────────────
The family name shown in the picker is derived from the filename.
Weight/style suffixes are stripped automatically.

Examples:
  Playfair-Display.woff2       → "Playfair Display"
  Playfair-Display-Bold.woff2  → "Playfair Display"  (same family, bold weight)
  JetBrainsMono-Regular.ttf    → "JetBrainsMono"
  Lora.woff2                   → "Lora"

You can drop multiple weights of the same font — they'll all load
under the same family name.

WHERE TO FIND FREE FONTS
─────────────────────────
  Google Fonts  → fonts.google.com  (download → extract the .ttf files)
  Font Squirrel → fontsquirrel.com
  DaFont        → dafont.com

On Google Fonts: click a font → "Download family" → unzip → 
drop the .ttf files here.

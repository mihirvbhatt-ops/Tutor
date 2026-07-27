// ── SETTINGS UI ───────────────────────────────────────────────────────────────
function syncSettingsUI() {
  loadApiKeyStatus();
  get('s-font').value    = settings.fontFamily;
  get('s-size').value    = settings.fontSize;
  get('size-val').textContent = settings.fontSize + 'px';
  get('s-dark').checked  = settings.darkMode;

  qa('#swatches-accent .swatch').forEach(s => s.classList.toggle('active', s.dataset.c === settings.accentColor));

  const bgKey = settings.darkMode ? 'bgColorDark' : 'bgColorLight';
  get('swatches-bg-dark').classList.toggle('hidden', !settings.darkMode);
  get('swatches-bg-light').classList.toggle('hidden', settings.darkMode);
  qa('#swatches-bg-dark .swatch[data-c]').forEach(s => s.classList.toggle('active', s.dataset.c === settings[bgKey]));
  qa('#swatches-bg-light .swatch[data-c]').forEach(s => s.classList.toggle('active', s.dataset.c === settings[bgKey]));
}

function updateSetting(key, val) {
  settings[key] = val;
  saveSettings(settings);
  applySettings(settings);
  syncSettingsUI();
}

get('s-font').addEventListener('change', e => updateSetting('fontFamily', e.target.value));

get('s-size').addEventListener('input', e => {
  get('size-val').textContent = e.target.value + 'px';
  updateSetting('fontSize', Number(e.target.value));
});

get('s-dark').addEventListener('change', e => updateSetting('darkMode', e.target.checked));

qa('#swatches-accent .swatch[data-c]').forEach(s => s.addEventListener('click', () => updateSetting('accentColor', s.dataset.c)));
get('s-accent-custom').addEventListener('input', e => updateSetting('accentColor', e.target.value));

qa('#swatches-bg-dark .swatch[data-c]').forEach(s => s.addEventListener('click', () => updateSetting('bgColorDark', s.dataset.c)));
get('s-bg-custom-dark').addEventListener('input', e => updateSetting('bgColorDark', e.target.value));

qa('#swatches-bg-light .swatch[data-c]').forEach(s => s.addEventListener('click', () => updateSetting('bgColorLight', s.dataset.c)));
get('s-bg-custom-light').addEventListener('input', e => updateSetting('bgColorLight', e.target.value));

get('btn-reset-settings').addEventListener('click', () => {
  settings = { ...DFLT_SETTINGS };
  saveSettings(settings);
  applySettings(settings);
  syncSettingsUI();
});

// ── AI Provider / API key (roadmap #3) ──────────────────────────────────────
// The key itself never comes back from the server once saved — only a
// status + a last-4-characters preview (see /api/settings/api-key) — so
// there's nothing here to leak, just state to reflect.
async function loadApiKeyStatus() {
  let status;
  try { status = await getJson('/api/settings/api-key'); }
  catch { status = { hasKey: false, source: null, provider: 'anthropic', keyPreview: null }; }
  renderApiKeyStatus(status);
  get('no-key-banner').classList.toggle('hidden', status.hasKey);
  return status;
}

// ── Update check (roadmap #4) ────────────────────────────────────────────────
async function loadUpdateStatus() {
  let status;
  try { status = await getJson('/api/update-check'); }
  catch { return; }

  if (status.currentVersion) get('version-badge').textContent = `v${status.currentVersion}`;

  const banner = get('update-banner');
  if (!status.updateAvailable) {
    banner.classList.add('hidden');
    return;
  }
  get('update-banner-text').textContent = `⬆️ Update available: v${status.latestVersion} (you're on v${status.currentVersion})`;
  get('update-banner-link').href = status.releaseUrl || '#';
  banner.classList.remove('hidden');
}

function renderApiKeyStatus(status) {
  const statusEl = get('apikey-status');
  const clearBtn = get('btn-apikey-clear');
  statusEl.classList.remove('ok', 'err');
  if (status.hasKey) {
    statusEl.classList.add('ok');
    statusEl.textContent = status.source === 'env'
      ? `✓ Using the ANTHROPIC_API_KEY environment variable (ending ${status.keyPreview})`
      : `✓ Key saved (ending ${status.keyPreview})`;
    // A key saved here is silently shadowed while the env var is set —
    // nothing to "clear" in that state since the env var isn't this UI's to manage.
    clearBtn.classList.toggle('hidden', status.source !== 'file');
  } else {
    statusEl.textContent = 'No key set — AI features are disabled. Local-only generation still works.';
    clearBtn.classList.add('hidden');
  }
}

get('btn-apikey-save').addEventListener('click', async () => {
  const input = get('s-apikey-input');
  const statusEl = get('apikey-status');
  const key = input.value.trim();
  if (!key) {
    statusEl.classList.remove('ok');
    statusEl.classList.add('err');
    statusEl.textContent = 'Enter a key first.';
    return;
  }

  const btn = get('btn-apikey-save');
  btn.disabled = true;
  statusEl.classList.remove('ok', 'err');
  statusEl.textContent = 'Validating…';

  try {
    const data = await post('/api/settings/api-key', { apiKey: key, provider: get('s-provider').value });
    input.value = '';
    await loadApiKeyStatus();
    statusEl.classList.add('ok');
    statusEl.textContent = data.shadowedByEnv
      ? '✓ Saved — but the ANTHROPIC_API_KEY environment variable is set and takes precedence over this.'
      : `✓ Key saved (ending ${data.keyPreview})`;
  } catch (err) {
    statusEl.classList.add('err');
    statusEl.textContent = err.message || 'Could not save the key.';
  } finally {
    btn.disabled = false;
  }
});

get('btn-apikey-clear').addEventListener('click', async () => {
  await del('/api/settings/api-key');
  await loadApiKeyStatus();
});

get('btn-no-key-settings').addEventListener('click', () => {
  showView('settings');
  get('s-apikey-input').focus({ preventScroll: true });
});

// ── Markdown renderer ─────────────────────────────────────────────────────────
// roadmap #18 — the previous hand-rolled regex parser had no support for
// code fences, tables, links, or nested lists, and its paragraph-wrapping
// rules mangled edge cases. Now backed by marked (loaded via CDN, same
// pattern as Chart.js above), with the *same* escape-first safety invariant
// the old parser had: HTML-significant characters are neutralised before
// marked ever sees the text, so any raw HTML in the source (model output,
// scraped pages, uploaded documents) renders as inert escaped text instead
// of being parsed as real markup — marked itself does not sanitize.
//
// Links are deliberately not supported: marked emits whatever href a
// [text](url) gives it (e.g. a javascript: URL) with no scheme sanitization,
// and this app's markdown source is model/scraped-content-controlled, not
// trusted. Rather than build and maintain a URL allowlist, link syntax is
// rejected outright — surfaced as an error instead of silently stripped or
// rendered unsafely.
const MD_LINK_RE = /!?\[[^\]]*\]\([^)]*\)/;
function markdownToHtml(md) {
  if (MD_LINK_RE.test(md)) {
    return '<p class="md-error">⚠ This response contains a link, which isn’t supported.</p>';
  }
  const escaped = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return marked.parse(escaped);
}

// ── Custom font loader ────────────────────────────────────────────────────────
// Scans public/fonts/ via the server, injects @font-face rules, and adds
// each discovered family to the Settings font picker automatically.
async function loadCustomFonts() {
  let fonts;
  try { fonts = await getJson('/api/fonts'); }
  catch { return; }
  if (!fonts.length) return;

  const FORMAT = { woff2:'woff2', woff:'woff', ttf:'truetype', otf:'opentype' };
  const styleEl = document.createElement('style');

  for (const { family, files } of fonts) {
    // Build @font-face for every file belonging to this family
    for (const file of files) {
      const ext = file.split('.').pop().toLowerCase();
      const fmt = FORMAT[ext] || 'truetype';
      styleEl.textContent += `@font-face{font-family:"${family}";src:url("/fonts/${encodeURIComponent(file)}")format("${fmt}");}\n`;
    }

    // Register in the FONTS map so applySettings() can use it
    const key = family.toLowerCase().replace(/\s+/g, '_');
    FONTS[key] = `"${family}",sans-serif`;

    // Add option to the Settings dropdown (skip if already there)
    const sel = get('s-font');
    if (!sel.querySelector(`option[value="${key}"]`)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = family;
      sel.appendChild(opt);
    }
  }

  document.head.appendChild(styleEl);

  // Re-apply settings in case the currently saved font is a custom one
  applySettings(settings);
}


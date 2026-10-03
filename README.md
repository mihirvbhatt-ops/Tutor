# AI Tutor

A local-first study app: turn your own notes, lecture slides, or a URL into
explanations, flashcards, and quizzes — with an antique-library-themed shelf
of everything you've studied. Runs entirely on your own machine, using your
own Anthropic API key — or, for some or all of it, a local model through
Ollama.

![Library view — an antique room with a lit fireplace and two full-height bookcases, one shelving topics and one shelving courses](docs/screenshots/library.png)

## Features

- **Three study modes per topic** — structured Explanations (streamed,
  markdown-rendered), 3D-flip Flashcards, and multiple-choice Quizzes with a
  pausable on-screen timer
- **Bring your own material** — paste text, scrape a URL, search the web
  (with your own Tavily / Brave / Serper key), or upload a PDF / Word /
  PowerPoint file; structure (headings, tables, slide titles) is recovered
  directly instead of flattened into a blob. When you'd rather Claude find
  its own sources — a "Use AI" topic with no material at all — it can
  search the web itself via Anthropic's native web search tool, no extra
  key needed
- **Hybrid local + AI question generation** — a local, zero-API-call
  pattern-extraction pass covers the easy definitional tier; a small AI call
  tops it up with synthesis-style questions the local pass can't produce.
  Choose "With AI" / "Both" / "Without AI" per topic
- **Run it locally with Ollama** — point Settings → Local Model at an Ollama
  host and choose, separately for grading, question generation, and
  explanations/chat, whether each runs on Claude or on your own machine
- **Multiple simultaneous study tabs** — the same topic or several different
  ones, open side by side, each with its own progress
- **Courses** — group topics into an ordered syllabus with prerequisites and
  per-topic status, plus a generated study guide across the whole course
- **A library you can arrange** — rename, edit, or delete topics, and give
  each one its own book cover (size, color, and spine band)
- **Stats** — accuracy trends over time, streaks, and a session history,
  per topic or overall
- **Your data, portable** — export everything as readable JSON or download
  the database file itself as a backup, from Settings → Your Data
- **Update notice** — the app checks GitHub for a newer release and says so
  in Settings
- **Installable PWA** with offline shell caching
- **Fully themeable** — accent color, background, font, and text size, all
  persisted locally

## Architecture

This is deliberately **local-first, not multi-tenant**: one person, one
running instance, one `tutor.db` file, one API key that only that person
pays for. There's no login system because there's nothing to log into — the
app *is* your account.

**Stack:** Node.js + Express, better-sqlite3 (with an automatic pure-JS
`sql.js` fallback if the native module can't build on your machine),
vanilla JS on the frontend (no framework, no bundler — see
[`public/js/`](./public/js)), the Anthropic Messages API for generation,
and optionally Ollama for local inference.

## Quick start

Requires **Node 20+**.

```bash
git clone https://github.com/mihirvbhatt-ops/Tutor.git
cd Tutor
npm install
npm start
```

> Don't want to deal with git and npm by hand? [`install.sh`](./install.sh) does
> the clone (or update, if already installed) and `npm install` for you,
> into `~/ai-tutor` (override with `INSTALL_DIR`). Re-run it any time to pull
> the latest release:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/mihirvbhatt-ops/Tutor/main/install.sh | bash
> ```

Open `http://localhost:3001`, then add your [Anthropic API key](https://console.anthropic.com/settings/keys)
under **Settings → AI Provider** (needs billing configured on your Anthropic
account — you're paying for your own usage directly, there's no markup and
no middleman). The app works before that too — local-only question
generation ("Without AI") needs no API access at all, and a model under
**Settings → Local Model** can stand in for Claude entirely.

> Prefer an environment variable instead? `cp .env.example .env`, paste your
> key in, and start the app — it takes precedence over whatever's saved in
> Settings. That's the dev/CI-friendly path; pasting into Settings is the
> one anyone else can actually use.

> First install compiles `better-sqlite3`, a native module — this needs a
> C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on
> Linux, or the "Desktop development with C++" workload on Windows). If it
> fails, the app still runs — it automatically falls back to the pure-JS
> `sql.js` engine, just slower per write. Rerun `npm rebuild better-sqlite3`
> once your toolchain is set up to get native performance back.

## Scripts

| Command | Does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file change |
| `npm test` | Run the test suite |
| `npm run lint` | ESLint |
| `npm run format:check` | Check formatting without changing anything |
| `npm run format` | Apply Prettier formatting |

## Privacy

Your notes and any material you upload are sent to Anthropic's API (under
your own key) to generate explanations and questions — except for any part
you've routed to a local model, which stays on your machine. Web searches
go to whichever search provider you configured, and a URL you add is
fetched directly from that site. Everything else — your topics, progress,
and stats — lives only in `db/tutor.db`, and your API keys only in
`db/config.json`, both on your own machine. Nothing is collected, logged,
or shared by this project itself.

## License

[MIT](./LICENSE)

# Medium to Markdown

A Chrome extension that converts the Medium article you're viewing into a clean Markdown file with one click. The output is optimized for both human reading and agent consumption - YAML frontmatter, semantic headings, fenced code blocks, normalized image URLs.

No tracking. No external services. The conversion runs entirely in your browser against the article DOM.

## Features

- **One-click download** from the toolbar icon, or right-click → **Medium to Markdown → Save as Markdown**
- **Save raw HTML** (right-click submenu) for offline archiving or building test fixtures
- **YAML frontmatter** with title, author, source URL, published date, reading time, and subtitle
- **Heading hierarchy** - Medium represents both "Heading" and "Subheading" as `<h2>`; the converter detects the distinct CSS class patterns and emits `##` / `###` accordingly
- **Code blocks** preserved with sibling-span newline handling and best-effort language detection (Python, JavaScript, Go, Rust, Java, SQL, HTML, JSON, Bash)
- **Inline formatting** - bold, italic, inline code, links (with Medium tracking params stripped)
- **Lists** including nesting
- **Images** rendered as `![alt](url)`, with the Medium CDN URL normalized to drop `resize:fit:NNN/format:webp/` segments
- **UI chrome stripped** - no "Listen", "Share", "Sign up to discover", "Member-only story", or "Press enter to view image" leaking into your output
- **Custom publication domains** supported (e.g. `javascript.plainenglish.io`) via `activeTab` permission

## Install (load unpacked)

1. Clone this repo
2. Open `chrome://extensions` and enable **Developer mode** (top right)
3. Click **Load unpacked** and pick this directory
4. The "M↓" icon appears in your toolbar

## Usage

On any Medium article:

- **Toolbar icon** → downloads `<article-slug>.md` to your Downloads folder
- **Right-click → Medium to Markdown → Save as Markdown** → same as above
- **Right-click → Medium to Markdown → Save raw HTML (for testing)** → downloads the page HTML, useful for adding new test fixtures

The output filename is slugged from the article title. Files land in your default Downloads folder; nothing else happens.

## Development

```bash
bun install
bun run test
```

The test harness lives in `tests/converter.test.js`. It auto-discovers `.html` fixtures from two places:

- `tests/fixtures/` - committed synthetic fixtures (always present, used for CI sanity)
- `examples/` - gitignored, your own real-world Medium HTML you've saved locally

For each fixture it runs a 17-check **universal smoke suite** including a "first/last body paragraph appears in markdown" regression check that catches structural bugs (e.g. when Medium splits a single article across multiple sibling block groups). Per-article assertions can be layered on top via the `customAssertions` map keyed by file basename.

### Adding new test fixtures

The fastest way to grow the corpus:

1. Open a Medium article in Chrome with this extension installed
2. Right-click → **Medium to Markdown → Save raw HTML (for testing)**
3. Move the downloaded `.html` into `examples/` (or `tests/fixtures/` if it's an original/synthetic fixture you'd like to commit)
4. Run `bun run test` - the new file is picked up automatically and run through the smoke suite

### Project layout

```
src/
  converter.js     Pure DOM → Markdown function. Runs in both Chrome and Node (jsdom).
  content.js       Content script shim - invokes the converter and returns the result.
  background.js    Service worker: toolbar / context menu handlers, downloads.
manifest.json      MV3 manifest (activeTab, scripting, downloads, contextMenus, notifications).
icons/             Toolbar icons (16/48/128) + source SVG.
tests/
  converter.test.js  Bun + jsdom harness with auto-discovery and smoke suite.
  fixtures/        Committed synthetic fixtures.
examples/          Gitignored - drop real Medium .html files here for local testing.
```

## How parsing works

Medium serves the full article content in the initial HTML - no client-side data fetching is needed. The converter:

1. Finds the `<article>` element
2. Locates the body container as the **lowest common ancestor of the first and last `p.pw-post-body-paragraph`** - this matters because Medium splits a single post into multiple sibling "block group" wrappers, and naively anchoring on the first paragraph alone misses everything in later groups
3. Recursively flattens that container into a list of block-level elements (`p`, `pre`, `h2`, `ul`, `figure`, etc.), stopping at block boundaries
4. Filters out the title (already in metadata), the subtitle (already in metadata), and UI chrome paragraphs (kept distinct from body paragraphs by the `pw-post-body-paragraph` class)
5. Walks the heading class patterns to assign markdown levels - first `<h2>` class seen → `##`, subsequent distinct classes → `###`, `####`, …
6. Renders each block to Markdown

The converter is intentionally tolerant of Medium's obfuscated CSS class names - every selector that matters relies on stable `pw-*` semantic classes or structural relationships, not on the volatile generated classes.

## Known limitations

- **No table support** - Medium doesn't store tables as `<table>`; authors usually paste them as plain text inside a paragraph, which we render verbatim
- **No embeds** - tweets, gists, YouTube embeds become blank or are stripped (they live in iframes that aren't part of the article DOM)
- **Code language detection is heuristic** - Medium doesn't preserve the language label, so detection is best-effort. When uncertain, the fence is unlabeled
- **Member-only paywalled articles** are converted from whatever's visible in the DOM, which may be a teaser if you're not logged in

## License

MIT - see [LICENSE](./LICENSE).

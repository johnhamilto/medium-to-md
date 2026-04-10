import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load the converter via module.exports.
const converterSrc = readFileSync(join(projectRoot, 'src/converter.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'globalThis', converterSrc)(mod, mod.exports, globalThis);
const { convertMediumToMarkdown } = mod.exports;

const fixturesDir = join(projectRoot, 'examples');
const outputDir = join(projectRoot, 'tests/output');
mkdirSync(outputDir, { recursive: true });

// Per-fixture extra assertions, keyed by file basename (without .html).
// Universal smoke checks run on every fixture; these layer on top.
// Signature: (result, check) — add a `doc` arg if a future assertion needs raw DOM access.
const customAssertions = {
  'claude-compaction': (result, check) => {
    const md = result.markdown;
    check('claude-compaction: title contains "Claude Compaction"', result.title.includes('Claude Compaction'));
    check(
      'claude-compaction: filename slug',
      result.filename === 'claude-compaction-the-secret-to-infinite-length-conversations.md',
      result.filename,
    );
    check('claude-compaction: author = Reliable Data Engineering', result.metadata.author === 'Reliable Data Engineering');
    check('claude-compaction: published = 2026-03-08', result.metadata.published === '2026-03-08');
    check('claude-compaction: reading_time present', result.metadata.readingTime === '14 min read');
    check('claude-compaction: subtitle mentions 200K', (result.metadata.subtitle || '').includes('200K'));
    check('claude-compaction: >=10 H2 sections', (md.match(/^## /gm) || []).length >= 10);
    check('claude-compaction: >=15 H3 subsections', (md.match(/^### /gm) || []).length >= 15);
    check('claude-compaction: first h2 = "The Problem Compaction Solves"', /^## The Problem Compaction Solves$/m.test(md));
    check('claude-compaction: first h3 = "The Mechanics"', /^### The Mechanics$/m.test(md));
    check('claude-compaction: has code blocks', (md.match(/```/g) || []).length >= 6);
    check('claude-compaction: has numbered list', /^1\. /m.test(md));
    check('claude-compaction: has inline `input_tokens`', md.includes('`input_tokens`'));
    check('claude-compaction: contains closing line', md.includes('Compaction: Because 200K tokens'));
  },
  griddy: (result, check) => {
    const md = result.markdown;
    check('griddy: title mentions CSS Grid', result.title.includes('CSS Grid'));
    check('griddy: contains "## Summary" section', /^## Summary$/m.test(md));
    check(
      'griddy: closing "Next Step" paragraph present (regression)',
      md.includes('Open your') && md.includes('package.json') && md.includes('npm uninstall'),
    );
    check('griddy: contains "browser has evolved"', md.includes('browser has evolved'));
  },
};

// --- Universal smoke checks --------------------------------------------

function runSmokeChecks(name, result, doc, check) {
  const md = result.markdown;

  // Result shape
  check(`${name}: produces non-empty markdown`, md && md.length > 0, `length=${(md || '').length}`);
  check(`${name}: result has a title`, !!result.title, result.title);
  check(`${name}: filename ends in .md`, /\.md$/.test(result.filename), result.filename);

  // Frontmatter
  check(`${name}: starts with YAML frontmatter`, md.startsWith('---\n'));
  check(`${name}: frontmatter has title key`, /\ntitle: /.test(md));
  check(`${name}: frontmatter has author key`, /\nauthor: /.test(md));
  check(`${name}: frontmatter has source_url key`, /\nsource_url: /.test(md));
  check(`${name}: frontmatter closes properly`, /\n---\n/.test(md.slice(4)));

  // H1 visible after frontmatter
  check(`${name}: has visible H1`, /\n# .+/.test(md));

  // No leaked Medium UI chrome
  check(`${name}: no "Listen" button leaked`, !/^Listen$/m.test(md));
  check(`${name}: no "Share" button leaked`, !/^Share$/m.test(md));
  check(`${name}: no "Sign up to discover" CTA`, !md.includes('Sign up to discover'));
  check(`${name}: no "Member-only story" badge`, !/Member-only story/.test(md));
  check(`${name}: no "Press enter or click to view image"`, !md.includes('Press enter or click to view image'));

  // Body integrity — both first and last body paragraphs must survive
  const article = doc.querySelector('article');
  if (article) {
    const paras = article.querySelectorAll('p.pw-post-body-paragraph');
    if (paras.length > 0) {
      const first = paras[0];
      const last = paras[paras.length - 1];
      check(
        `${name}: first body paragraph appears in markdown`,
        markdownContainsParagraph(md, first),
        excerpt(first),
      );
      check(
        `${name}: last body paragraph appears in markdown (regression: split block groups)`,
        markdownContainsParagraph(md, last),
        excerpt(last),
      );
    }
  }

  // Plaintext sanity
  const plain = md.replace(/```[\s\S]*?```/g, '').replace(/[#*_`>-]/g, '').trim();
  check(`${name}: plaintext body >= 200 chars`, plain.length >= 200, `length=${plain.length}`);
}

// Robust paragraph-presence check: normalize both sides to lowercase
// alphanumerics-only, then look for a window from the middle of the paragraph
// in the normalized markdown. Tolerates curly quotes, em-dashes, inline markdown
// wrapping (**bold**, _italic_, `code`, [links]), and whitespace differences.
function markdownContainsParagraph(md, pEl) {
  const text = (pEl.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length < 6) return true; // trivially short — skip

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normMd = norm(md);
  const normText = norm(text);

  if (normText.length < 20) return normMd.includes(normText);

  // Take a 40-char window starting ~25% into the paragraph. Long enough to be
  // unique within the article, short enough to survive small inline rewrites.
  const start = Math.floor(normText.length * 0.25);
  const fingerprint = normText.slice(start, start + 40).trim();
  return normMd.includes(fingerprint);
}

function excerpt(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// --- Run all fixtures ---------------------------------------------------

const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.html'))
  .sort();

if (fixtureFiles.length === 0) {
  console.error(`No fixtures found in ${fixturesDir}.`);
  process.exit(1);
}

let totalChecks = 0;
let totalFailures = 0;

for (const file of fixtureFiles) {
  const name = basename(file, '.html');
  const html = readFileSync(join(fixturesDir, file), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let result;
  try {
    result = convertMediumToMarkdown(doc);
  } catch (err) {
    console.error(`\n${name}: converter threw — ${err.message}`);
    totalFailures += 1;
    totalChecks += 1;
    continue;
  }

  writeFileSync(join(outputDir, result.filename), result.markdown);

  const checks = [];
  const check = (label, pass, detail) => checks.push({ label, pass: !!pass, detail });

  runSmokeChecks(name, result, doc, check);
  if (customAssertions[name]) customAssertions[name](result, check);

  const failures = checks.filter((c) => !c.pass).length;
  totalChecks += checks.length;
  totalFailures += failures;

  const passed = checks.length - failures;
  const status = failures === 0 ? 'PASS' : 'FAIL';
  console.log(`\n[${status}] ${name}.html  (${passed}/${checks.length})  → tests/output/${result.filename}`);
  for (const c of checks) {
    const icon = c.pass ? '  pass' : '  FAIL';
    console.log(`${icon}  ${c.label}${c.detail && !c.pass ? ` — got: ${String(c.detail).slice(0, 120)}` : ''}`);
  }
}

console.log();
if (totalFailures) {
  console.error(`${totalFailures}/${totalChecks} checks failed across ${fixtureFiles.length} fixture(s).`);
  process.exit(1);
}
console.log(`All ${totalChecks} checks passing across ${fixtureFiles.length} fixture(s).`);

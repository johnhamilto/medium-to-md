import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const converterSrc = readFileSync(join(projectRoot, 'src/converter.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'globalThis', converterSrc)(mod, mod.exports, globalThis);
const { convertMediumToMarkdown } = mod.exports;

const which = process.argv[2] || 'griddy';
const html = readFileSync(join(projectRoot, `examples/${which}.html`), 'utf8');
const dom = new JSDOM(html);
const result = convertMediumToMarkdown(dom.window.document);

console.log(`Title: ${result.title}`);
console.log(`Length: ${result.markdown.length} bytes`);

const lines = result.markdown.split('\n');
console.log(`\nLast 12 lines (${lines.length} total):`);
for (const l of lines.slice(-12)) console.log(' |', l);

mkdirSync(join(projectRoot, 'tests/output'), { recursive: true });
writeFileSync(join(projectRoot, 'tests/output', result.filename), result.markdown);
console.log(`\nWrote tests/output/${result.filename}`);

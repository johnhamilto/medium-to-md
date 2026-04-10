// Medium article HTML -> Markdown converter.
//
// Pure function: takes a Document, returns { markdown, title, filename, metadata }.
// Safe to run in both browser (content script) and Node (tests via jsdom).
// No external dependencies. No DOM mutation.

(function (globalObj) {
  function convertMediumToMarkdown(doc) {
    const metadata = extractMetadata(doc);
    const article = doc.querySelector('article');
    if (!article) {
      throw new Error('No <article> element found — this does not look like a Medium article.');
    }

    const bodyContainer = findBodyContainer(article);
    if (!bodyContainer) {
      throw new Error('Could not locate the article body container.');
    }

    const blocks = flattenBlocks(bodyContainer).filter(isBodyBlock);
    const headingLevels = computeHeadingLevels(blocks);
    const bodyBlocks = [];
    for (const el of blocks) {
      const block = renderBlock(el, headingLevels);
      if (block) bodyBlocks.push(block);
    }

    const body = bodyBlocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const frontmatter = renderFrontmatter(metadata);
    const leadLine = metadata.title ? `# ${metadata.title}\n` : '';
    const subtitleLine = metadata.subtitle ? `\n_${escapeForItalic(metadata.subtitle)}_\n` : '';

    const markdown = `${frontmatter}\n${leadLine}${subtitleLine}\n${body}\n`;

    return {
      markdown,
      title: metadata.title || 'Untitled',
      filename: makeFilename(metadata.title, metadata.slug),
      metadata,
    };
  }

  // --- Metadata extraction ------------------------------------------------

  function extractMetadata(doc) {
    const meta = (name) => {
      const el =
        doc.querySelector(`meta[property="${name}"]`) ||
        doc.querySelector(`meta[name="${name}"]`);
      return el ? el.getAttribute('content') : null;
    };

    const title =
      meta('og:title') ||
      textOf(doc.querySelector('h1[data-testid="storyTitle"]')) ||
      textOf(doc.querySelector('h1.pw-post-title')) ||
      (doc.title || '').replace(/\s*\|\s*Medium.*$/, '').trim();

    const subtitleEl =
      doc.querySelector('h2.pw-subtitle-paragraph') ||
      doc.querySelector('h2[data-testid="storySubtitle"]');
    const subtitle = subtitleEl ? textOf(subtitleEl) : null;

    const author = meta('author') || textOf(doc.querySelector('[data-testid="authorName"]'));
    const authorUrl = meta('article:author') || null;

    const publishedRaw = meta('article:published_time');
    const published = publishedRaw ? publishedRaw.slice(0, 10) : null;

    const url = meta('og:url') || (doc.location && doc.location.href) || null;
    const readingTime = meta('twitter:data1') || null;

    const description = meta('og:description') || null;

    // Try to parse article ID / slug from URL
    let slug = null;
    if (url) {
      const m = url.match(/\/([a-z0-9-]+)-([a-f0-9]{8,})(?:\?|#|$)/i);
      if (m) slug = m[1];
      else {
        const parts = url.replace(/\?.*$/, '').replace(/#.*$/, '').split('/');
        const last = parts.filter(Boolean).pop() || '';
        slug = last.replace(/-[a-f0-9]{8,}$/i, '');
      }
    }

    return {
      title,
      subtitle,
      author,
      authorUrl,
      published,
      url,
      readingTime,
      description,
      slug,
    };
  }

  function renderFrontmatter(m) {
    const lines = ['---'];
    const add = (k, v) => {
      if (v == null || v === '') return;
      lines.push(`${k}: ${yamlString(v)}`);
    };
    add('title', m.title);
    add('author', m.author);
    add('author_url', m.authorUrl);
    add('published', m.published);
    add('source', 'Medium');
    add('source_url', m.url);
    if (m.readingTime) add('reading_time', m.readingTime);
    if (m.subtitle) add('subtitle', m.subtitle);
    lines.push('---');
    return lines.join('\n') + '\n';
  }

  function yamlString(v) {
    const s = String(v);
    // Quote if it contains anything that could confuse a YAML parser.
    if (/[:#\n"'\\\[\]{}&*!|>%@`]/.test(s) || /^\s|\s$/.test(s) || /^[-?]/.test(s)) {
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return s;
  }

  // --- Body container discovery ------------------------------------------

  // The lowest ancestor of the first body paragraph that also contains the last
  // body paragraph. Medium splits posts into multiple sibling "block groups", so
  // anchoring on the first paragraph alone misses everything in later groups.
  // isBodyBlock() handles stripping out the title/byline/UI chrome that this
  // wider container will sweep up.
  function findBodyContainer(article) {
    const paras = article.querySelectorAll('p.pw-post-body-paragraph');
    if (paras.length === 0) return article;
    const firstPara = paras[0];
    const lastPara = paras[paras.length - 1];

    let node = firstPara;
    while (node && node !== article.parentElement) {
      if (node.contains(lastPara)) return node;
      node = node.parentElement;
    }
    return article;
  }

  const BLOCK_TAGS = new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'pre',
    'ul',
    'ol',
    'figure',
    'blockquote',
    'hr',
  ]);

  // Flatten the wrapper-soup into a list of block-level elements in document order.
  // Stops descending at block boundaries — we never walk *into* a <pre>, <ul>, etc.
  function flattenBlocks(root) {
    const blocks = [];
    const walk = (el) => {
      for (const child of el.children) {
        const tag = child.tagName.toLowerCase();
        if (BLOCK_TAGS.has(tag)) {
          blocks.push(child);
        } else {
          walk(child);
        }
      }
    };
    walk(root);
    return blocks;
  }

  // Decide whether a flattened block is part of the article body (vs. UI chrome,
  // the title, the subtitle, or the byline that also live inside the article).
  function isBodyBlock(el) {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (tag === 'h1') return false; // title surfaces via metadata
    if (tag === 'h2' && /\bpw-subtitle-paragraph\b/.test(cls)) return false;
    if (tag === 'p' && !/\bpw-post-body-paragraph\b/.test(cls)) return false;
    return true;
  }

  // Medium represents both "Heading" and "Subheading" as <h2>, distinguished only
  // by obfuscated CSS classes. The first <h2> class pattern we see is treated as
  // the section level (h2); subsequent distinct patterns become progressively
  // deeper (h3, h4, ...). Honors explicit h3/h4 tags when Medium actually emits
  // them.
  function computeHeadingLevels(blocks) {
    const h2Classes = new Map(); // normalized class -> markdown level
    let next = 2;
    for (const el of blocks) {
      if (el.tagName.toLowerCase() !== 'h2') continue;
      const key = (el.className || '').trim();
      if (!h2Classes.has(key)) {
        h2Classes.set(key, Math.min(next, 6));
        next += 1;
      }
    }
    return h2Classes;
  }

  // --- Block-level rendering ---------------------------------------------

  function renderBlock(el, headingLevels) {
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case 'h1':
        return `# ${renderInline(el).trim()}`;
      case 'h2': {
        const level = headingLevels && headingLevels.get((el.className || '').trim());
        const hashes = '#'.repeat(Math.max(2, Math.min(6, level || 2)));
        return `${hashes} ${renderInline(el).trim()}`;
      }
      case 'h3':
        return `### ${renderInline(el).trim()}`;
      case 'h4':
        return `#### ${renderInline(el).trim()}`;
      case 'h5':
        return `##### ${renderInline(el).trim()}`;
      case 'h6':
        return `###### ${renderInline(el).trim()}`;
      case 'p': {
        const text = renderInline(el).trim();
        return text ? text : null;
      }
      case 'pre':
        return renderCodeBlock(el);
      case 'ul':
      case 'ol':
        return renderList(el, 0);
      case 'figure':
        return renderFigure(el);
      case 'blockquote':
        return renderBlockquote(el);
      case 'hr':
        return '---';
      case 'div':
      case 'section':
        // Walk into wrappers — some Medium elements nest their content.
        return renderChildBlocks(el);
      default:
        return null;
    }
  }

  function renderChildBlocks(el) {
    const parts = [];
    for (const child of el.children) {
      const block = renderBlock(child);
      if (block) parts.push(block);
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  function renderCodeBlock(pre) {
    // Medium renders code blocks as <pre><span>line1<br>line2<br>...</span></pre>.
    // Multi-cell code blocks become multiple sibling <span>s inside one <pre>,
    // with no <br> between them — each span starts on a new line visually,
    // so we insert a newline between sibling spans ourselves.
    const chunks = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3 /* text */) {
          chunks.push(child.textContent);
        } else if (child.nodeType === 1 /* element */) {
          const t = child.tagName.toLowerCase();
          if (t === 'br') {
            chunks.push('\n');
          } else {
            walk(child);
          }
        }
      }
    };

    // Walk top-level children of <pre>, joining sibling spans with newlines.
    const topChildren = Array.from(pre.childNodes).filter(
      (n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()),
    );
    topChildren.forEach((node, idx) => {
      if (idx > 0 && chunks.length && !chunks[chunks.length - 1].endsWith('\n')) {
        chunks.push('\n');
      }
      if (node.nodeType === 3) {
        chunks.push(node.textContent);
      } else {
        walk(node);
      }
    });

    const code = chunks.join('').replace(/\r/g, '');
    const lang = detectLanguage(pre, code);
    const fence = code.includes('```') ? '~~~' : '```';
    return `${fence}${lang}\n${code.replace(/\n+$/, '')}\n${fence}`;
  }

  function detectLanguage(pre, code) {
    // Medium doesn't preserve language info. Best-effort heuristics:
    // — explicit class hints (rare but possible)
    const cls = pre.className || '';
    const m = cls.match(/language-([a-z0-9]+)/i) || cls.match(/lang-([a-z0-9]+)/i);
    if (m) return m[1];

    // Lightweight content sniffing. Only emit a language when the signal is strong;
    // otherwise return '' (unlabeled fence).
    const c = code.trim();
    if (!c) return '';
    if (/^\s*(#!\/usr\/bin\/env python|import |from .+ import |def \w+\(|print\()/m.test(c)) return 'python';
    if (/^\s*(#!\/(usr\/)?bin\/(ba)?sh|\$\s)/m.test(c)) return 'bash';
    if (/^\s*(function \w+|const \w+\s*=|let \w+\s*=|=>\s*\{)/m.test(c)) return 'javascript';
    if (/^\s*(package \w+|func \w+|fmt\.)/m.test(c)) return 'go';
    if (/^\s*(fn \w+|let mut |impl |use \w+::)/m.test(c)) return 'rust';
    if (/^\s*(public |private |class \w+|System\.out)/m.test(c)) return 'java';
    if (/^\s*(SELECT |INSERT |UPDATE |DELETE |CREATE TABLE )/im.test(c)) return 'sql';
    if (/^\s*</.test(c) && /<\/\w+>/.test(c)) return 'html';
    if (/^\s*\{/.test(c) && /"[\w-]+"\s*:/.test(c)) return 'json';
    return '';
  }

  function renderList(listEl, depth) {
    const ordered = listEl.tagName.toLowerCase() === 'ol';
    const parts = [];
    let index = 1;
    for (const li of listEl.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const marker = ordered ? `${index}.` : '-';
      const itemText = renderListItem(li, depth);
      const indent = '  '.repeat(depth);
      // Indent continuation lines to align with the text after the marker.
      const prefix = `${indent}${marker} `;
      const contIndent = ' '.repeat(prefix.length);
      const linesOut = itemText.split('\n');
      const first = linesOut.shift() || '';
      const rest = linesOut.map((l) => (l ? contIndent + l : l)).join('\n');
      parts.push(prefix + first + (rest ? '\n' + rest : ''));
      index += 1;
    }
    return parts.join('\n');
  }

  function renderListItem(li, depth) {
    // A list item can contain inline text and nested lists.
    const inlineParts = [];
    const blockParts = [];
    for (const node of li.childNodes) {
      if (node.nodeType === 3) {
        inlineParts.push(node.textContent);
      } else if (node.nodeType === 1) {
        const t = node.tagName.toLowerCase();
        if (t === 'ul' || t === 'ol') {
          blockParts.push(renderList(node, depth + 1));
        } else if (t === 'p') {
          inlineParts.push(renderInline(node));
        } else {
          inlineParts.push(renderInline(node));
        }
      }
    }
    const head = inlineParts.join('').replace(/\s+/g, ' ').trim();
    return blockParts.length ? `${head}\n${blockParts.join('\n')}` : head;
  }

  function renderFigure(fig) {
    const img = fig.querySelector('img');
    if (!img) return null;
    const alt = (img.getAttribute('alt') || '').trim();
    const src = bestImageSrc(fig, img);
    if (!src) return null;
    const caption = fig.querySelector('figcaption');
    const captionText = caption ? renderInline(caption).trim() : '';
    // Use the caption as alt if the img alt is empty.
    const altFinal = alt || captionText || '';
    const imgLine = `![${altFinal}](${src})`;
    return captionText ? `${imgLine}\n\n_${escapeForItalic(captionText)}_` : imgLine;
  }

  function bestImageSrc(fig, img) {
    // Prefer the non-webp source (broader compatibility for agents).
    const sources = fig.querySelectorAll('source');
    let pngSrc = null;
    let webpSrc = null;
    for (const s of sources) {
      const type = s.getAttribute('type') || '';
      const srcset = s.getAttribute('srcSet') || s.getAttribute('srcset') || '';
      const largest = pickLargestFromSrcset(srcset);
      if (!largest) continue;
      if (type.includes('webp')) webpSrc = largest;
      else pngSrc = largest;
    }
    if (pngSrc) return normalizeMediumImage(pngSrc);
    if (webpSrc) return normalizeMediumImage(webpSrc);
    const direct = img.getAttribute('src');
    return direct ? normalizeMediumImage(direct) : null;
  }

  function pickLargestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestW = 0;
    for (const part of srcset.split(',')) {
      const trimmed = part.trim();
      const m = trimmed.match(/^(\S+)\s+(\d+)w$/);
      if (m) {
        const w = parseInt(m[2], 10);
        if (w > bestW) {
          bestW = w;
          best = m[1];
        }
      } else if (!best) {
        best = trimmed.split(/\s+/)[0];
      }
    }
    return best;
  }

  function normalizeMediumImage(src) {
    // Strip the /resize:fit:NNN/format:webp/ prefix to get a clean original URL.
    // e.g. https://miro.medium.com/v2/resize:fit:1400/format:webp/1*abc.png -> https://miro.medium.com/v2/1*abc.png
    if (!src) return src;
    try {
      return src.replace(/\/v2\/resize:[^/]+\/(?:format:[^/]+\/)?/, '/v2/');
    } catch (e) {
      return src;
    }
  }

  function renderBlockquote(bq) {
    const inner = renderChildBlocks(bq) || renderInline(bq).trim();
    return inner
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
  }

  // --- Inline rendering --------------------------------------------------

  function renderInline(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        out += node.textContent;
      } else if (node.nodeType === 1) {
        out += renderInlineElement(node);
      }
    }
    return out;
  }

  function renderInlineElement(el) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'strong':
      case 'b': {
        const inner = renderInline(el).trim();
        return inner ? `**${inner}**` : '';
      }
      case 'em':
      case 'i': {
        const inner = renderInline(el).trim();
        return inner ? `_${inner}_` : '';
      }
      case 'code': {
        const inner = el.textContent.replace(/`/g, '\u200b`');
        return inner ? `\`${inner}\`` : '';
      }
      case 'a': {
        const inner = renderInline(el).trim();
        const href = el.getAttribute('href') || '';
        if (!href) return inner;
        const cleanHref = cleanLinkHref(href);
        return inner ? `[${inner}](${cleanHref})` : cleanHref;
      }
      case 'br':
        return '  \n';
      case 'span':
      case 'u':
      case 'small':
        return renderInline(el);
      case 'sub':
        return `~${renderInline(el)}~`;
      case 'sup':
        return `^${renderInline(el)}^`;
      case 'img': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        return src ? `![${alt}](${normalizeMediumImage(src)})` : '';
      }
      default:
        return renderInline(el);
    }
  }

  function cleanLinkHref(href) {
    // Medium wraps external links in /r/?url=... redirects; unwrap if present.
    try {
      if (href.startsWith('/') && !href.startsWith('//')) {
        return `https://medium.com${href.replace(/\?source=[^&]*/g, '').replace(/[?&]$/, '')}`;
      }
      const u = new URL(href, 'https://medium.com');
      if (u.pathname === '/r/' || u.pathname === '/r') {
        const target = u.searchParams.get('url');
        if (target) return target;
      }
      // Drop the `source=post_page-...` tracking param on internal links
      if (u.hostname.endsWith('medium.com')) {
        u.searchParams.delete('source');
        return u.toString().replace(/\?$/, '');
      }
      return href;
    } catch (e) {
      return href;
    }
  }

  // --- Helpers ----------------------------------------------------------

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  }

  function escapeForItalic(s) {
    return s.replace(/_/g, '\\_');
  }

  function makeFilename(title, slug) {
    const base = (slug && slug.length > 3 ? slug : slugify(title || 'medium-article')).slice(0, 120);
    return `${base}.md`;
  }

  function slugify(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'medium-article';
  }

  // --- Export -----------------------------------------------------------

  const api = { convertMediumToMarkdown };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalObj.MediumToMd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

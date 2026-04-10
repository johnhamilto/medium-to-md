// Service worker: handles toolbar clicks and the context menu entries,
// injects the converter into the active tab, and downloads the result.

const MENU_PARENT = 'medium-to-md-parent';
const MENU_SAVE_MD = 'medium-to-md-save';
const MENU_COPY_MD = 'medium-to-md-copy';
const MENU_SAVE_HTML = 'medium-to-md-save-html';

chrome.runtime.onInstalled.addListener(() => {
  // Recreate from scratch on install/update so we don't accumulate stale entries.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PARENT,
      title: 'Medium to Markdown',
      contexts: ['page'],
      // No documentUrlPatterns: Medium publications live on custom domains
      // (e.g. javascript.plainenglish.io) and there's no wildcard that catches
      // all of them. Show on every page; the converter fails gracefully if the
      // page isn't actually a Medium article.
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_MD,
      parentId: MENU_PARENT,
      title: 'Save as Markdown',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_COPY_MD,
      parentId: MENU_PARENT,
      title: 'Copy as Markdown',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_HTML,
      parentId: MENU_PARENT,
      title: 'Save raw HTML (for testing)',
      contexts: ['page'],
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  void runMarkdownDownload(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SAVE_MD) {
    void runMarkdownDownload(tab);
  } else if (info.menuItemId === MENU_COPY_MD) {
    void runMarkdownCopy(tab);
  } else if (info.menuItemId === MENU_SAVE_HTML) {
    void runHtmlDownload(tab);
  }
});

// --- Markdown download --------------------------------------------------

async function runMarkdownDownload(tab) {
  if (!tab || typeof tab.id !== 'number') {
    await notify('No active tab to convert.');
    return;
  }

  let injection;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/converter.js', 'src/content.js'],
      world: 'ISOLATED',
    });
    injection = results && results[0] && results[0].result;
  } catch (err) {
    await notify(`Couldn't read the page: ${err.message || err}`);
    return;
  }

  if (!injection) {
    await notify('Converter returned no result.');
    return;
  }
  if (!injection.ok) {
    await notify(`Conversion failed: ${injection.error || 'unknown error'}`);
    return;
  }

  const { markdown, filename } = injection;
  if (!markdown) {
    await notify('Converter produced empty output.');
    return;
  }

  const dataUrl = textToDataUrl(markdown, 'text/markdown');
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: safeFilename(filename),
      saveAs: false,
    });
  } catch (err) {
    await notify(`Download failed: ${err.message || err}`);
  }
}

// --- Copy to clipboard --------------------------------------------------

async function runMarkdownCopy(tab) {
  if (!tab || typeof tab.id !== 'number') {
    await notify('No active tab to convert.');
    return;
  }

  let injection;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/converter.js', 'src/content.js'],
      world: 'ISOLATED',
    });
    injection = results && results[0] && results[0].result;
  } catch (err) {
    await notify(`Couldn't read the page: ${err.message || err}`);
    return;
  }

  if (!injection || !injection.ok) {
    await notify(`Conversion failed: ${(injection && injection.error) || 'unknown error'}`);
    return;
  }

  const { markdown } = injection;
  if (!markdown) {
    await notify('Converter produced empty output.');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: (text) => navigator.clipboard.writeText(text),
      args: [markdown],
    });
    await notify('Markdown copied to clipboard.');
  } catch (err) {
    await notify(`Clipboard write failed: ${err.message || err}`);
  }
}

// --- Raw HTML download --------------------------------------------------

async function runHtmlDownload(tab) {
  if (!tab || typeof tab.id !== 'number') {
    await notify('No active tab to save.');
    return;
  }

  let payload;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => ({
        html: '<!doctype html>\n' + document.documentElement.outerHTML,
        title: document.title || '',
        url: location.href,
      }),
    });
    payload = results && results[0] && results[0].result;
  } catch (err) {
    await notify(`Couldn't read the page: ${err.message || err}`);
    return;
  }

  if (!payload || !payload.html) {
    await notify('Failed to capture page HTML.');
    return;
  }

  const slug = slugFromUrl(payload.url) || slugFromTitle(payload.title) || 'medium-page';
  const dataUrl = textToDataUrl(payload.html, 'text/html');
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: safeFilename(`${slug}.html`),
      saveAs: false,
    });
  } catch (err) {
    await notify(`Download failed: ${err.message || err}`);
  }
}

// --- Helpers ------------------------------------------------------------

function textToDataUrl(text, mime) {
  // btoa requires binary-safe input; encode utf-8 first.
  const utf8 = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < utf8.length; i += 0x8000) {
    binary += String.fromCharCode(...utf8.subarray(i, i + 0x8000));
  }
  return `data:${mime};charset=utf-8;base64,${btoa(binary)}`;
}

function slugFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    // Strip Medium's trailing 12-char hex article id.
    const cleaned = last.replace(/-[a-f0-9]{8,}$/i, '');
    return cleaned.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || null;
  } catch {
    return null;
  }
}

function slugFromTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*[|·\-–—]\s*medium.*$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || null;
}

function safeFilename(name) {
  const cleaned = (name || 'medium-article')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'medium-article';
}

async function notify(message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Medium to Markdown',
      message,
    });
  } catch {
    // Notifications can fail on some platforms; swallow silently.
  }
}

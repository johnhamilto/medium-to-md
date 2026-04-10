// Injected into the current tab by background.js via chrome.scripting.executeScript.
// Loaded after src/converter.js, which defines globalThis.MediumToMd.convertMediumToMarkdown.
// The IIFE's return value becomes the injection result.

(() => {
  try {
    const api = (globalThis || window).MediumToMd;
    if (!api || typeof api.convertMediumToMarkdown !== 'function') {
      return { ok: false, error: 'Converter not loaded.' };
    }
    const result = api.convertMediumToMarkdown(document);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
})();

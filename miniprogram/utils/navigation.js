const store = require('./study-store');

function decodeQueryValue(value) {
  let text = value === undefined || value === null ? '' : String(value);
  // Navigation encodes query values; tolerate older saved routes encoded twice.
  for (let depth = 0; depth < 2; depth += 1) {
    if (!/%[0-9a-f]{2}/i.test(text)) break;
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch (_) { break; }
  }
  return text;
}

function openPage(path, params) {
  const query = Object.keys(params || {}).filter((key) => params[key] !== undefined && params[key] !== null).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');
  const url = path + (query ? `?${query}` : '');
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  if (pages.length >= 9) wx.redirectTo({ url });
  else wx.navigateTo({ url });
}

function continueLearning() {
  const resume = store.getResume();
  if (resume) openPage(resume.path, { ...resume.options, resume: 1 });
  else openPage('/pages/literature/index', { categoryId: 'pre-qin' });
}

module.exports = { openPage, continueLearning, decodeQueryValue };

const STORAGE_KEY = 'chinese-study.theme';

function normalize(value) {
  return value === 'night' ? 'night' : 'day';
}

function getTheme() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return 'day';
  try {
    return normalize(wx.getStorageSync(STORAGE_KEY));
  } catch (_) {
    return 'day';
  }
}

function setTheme(value) {
  const theme = normalize(value);
  if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
    try { wx.setStorageSync(STORAGE_KEY, theme); } catch (_) { /* Keep the current view usable if storage is unavailable. */ }
  }
  return theme;
}

function toggleTheme(current) {
  return setTheme(normalize(current) === 'night' ? 'day' : 'night');
}

module.exports = { getTheme, setTheme, toggleTheme };

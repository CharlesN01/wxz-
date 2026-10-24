const STORAGE_KEY = 'agent-attribution-v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCENE_RE = /^A=[A-Z0-9][A-Z0-9_-]{2,31}$/;

function decodeScene(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // WeChat 小程序码 delivers the scene field URL-encoded, so "a=TEST" arrives
  // as "a%3DTEST". Decode before matching; fall back to the raw value when the
  // string is not valid percent-encoding.
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function normalize(value) {
  const scene = decodeScene(value).toUpperCase();
  return SCENE_RE.test(scene) ? scene : '';
}

function extractScene(options) {
  if (!options || typeof options !== 'object') return '';
  // Page onLoad spreads query params onto options (options.scene); App
  // onLaunch/onShow nest them under options.query (options.query.scene).
  const query = options.query && typeof options.query === 'object' ? options.query : {};
  return normalize(options.scene) || normalize(query.scene);
}

function read() {
  try {
    const item = wx.getStorageSync(STORAGE_KEY);
    if (!item || !item.scene || Number(item.expiresAt) <= Date.now()) {
      if (item) wx.removeStorageSync(STORAGE_KEY);
      return '';
    }
    return normalize(item.scene);
  } catch (_) { return ''; }
}

function capture(options) {
  const scene = extractScene(options);
  if (!scene) return read();
  try { wx.setStorageSync(STORAGE_KEY, { scene, expiresAt: Date.now() + TTL_MS }); } catch (_) {}
  return scene;
}

module.exports = { capture, read, normalize };

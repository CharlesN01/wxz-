const STORAGE_KEY = 'agent-attribution-v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCENE_RE = /^a=[A-Z0-9][A-Z0-9_-]{2,31}$/;

function normalize(value) {
  const scene = String(value || '').trim().toUpperCase();
  return SCENE_RE.test(scene) ? scene : '';
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
  const query = options && options.query ? options.query : {};
  const scene = normalize(query.scene);
  if (!scene) return read();
  try { wx.setStorageSync(STORAGE_KEY, { scene, expiresAt: Date.now() + TTL_MS }); } catch (_) {}
  return scene;
}

module.exports = { capture, read, normalize };

const STORAGE_KEY = 'agent-attribution-v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCENE_RE = /^a=[A-Z0-9][A-Z0-9_-]{2,31}$/;

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
  const decoded = decodeScene(value);
  // Keep the "a=" prefix lowercase (matches backend regex and stored scene);
  // only the agent code portion is uppercase.
  const match = /^a=(.+)$/i.exec(decoded);
  if (!match) return '';
  const code = match[1].toUpperCase();
  const scene = 'a=' + code;
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

function sharePath(path) {
  const scene = read();
  if (!scene) return path;
  return `${path}${String(path).includes('?') ? '&' : '?'}scene=${encodeURIComponent(scene)}`;
}

function shareQuery() {
  const scene = read();
  return scene ? `scene=${encodeURIComponent(scene)}` : '';
}

function capture(options, { preserveOnEmpty = false } = {}) {
  // options is supplied by App onLaunch/onShow or page onLoad. When the user
  // enters via an agent QR code the scene parameter is present — save it.
  // When the user enters through any other path (direct link, official test
  // QR, weixin public platform) there is no scene, which means this is NOT
  // an agent-attributed session. Clear any previously cached scene so a prior
  // scan does not silently attribute future orders to that agent.
  //
  // preserveOnEmpty: onShow fires on every resume from background with no
  // scene in options. That is NOT a new entry decision — the user just came
  // back. Preserve the scene saved at onLaunch so an agent-scan session keeps
  // its attribution across background/foreground switches.
  if (options === undefined || options === null) {
    return read();
  }
  const scene = extractScene(options);
  if (!scene) {
    if (preserveOnEmpty) return read();
    try { wx.removeStorageSync(STORAGE_KEY); } catch (_) {}
    return '';
  }
  try { wx.setStorageSync(STORAGE_KEY, { scene, expiresAt: Date.now() + TTL_MS }); } catch (_) {}
  return scene;
}

module.exports = { capture, read, normalize, sharePath, shareQuery };

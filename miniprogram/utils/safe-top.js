function readStatusBarHeight(api) {
  if (!api) return 0;
  let info = null;
  if (typeof api.getWindowInfo === 'function') {
    try {
      info = api.getWindowInfo();
    } catch (_) {
      info = null;
    }
  }
  if (!info || !(Number(info.statusBarHeight) > 0)) {
    if (typeof api.getSystemInfoSync === 'function') {
      try {
        const systemInfo = api.getSystemInfoSync();
        if (systemInfo && Number(systemInfo.statusBarHeight) > 0) info = systemInfo;
      } catch (_) {
        // Older runtimes or Node tests may not expose system information.
      }
    }
  }
  const height = Number(info && info.statusBarHeight);
  return Number.isFinite(height) && height > 0 ? height : 0;
}

function readMenuButtonBottom(api) {
  if (!api || typeof api.getMenuButtonBoundingClientRect !== 'function') return 0;
  try {
    const rect = api.getMenuButtonBoundingClientRect();
    const bottom = Number(rect && rect.bottom);
    return Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
  } catch (_) {
    return 0;
  }
}

function getNavigationMetrics(api) {
  const runtime = api || (typeof wx !== 'undefined' ? wx : null);
  let info = null;
  if (runtime) {
    try { info = typeof runtime.getWindowInfo === 'function' ? runtime.getWindowInfo() : null; } catch (_) { /* Older base library. */ }
    if (!info) {
      try { info = typeof runtime.getSystemInfoSync === 'function' ? runtime.getSystemInfoSync() : null; } catch (_) { /* Preview fallback. */ }
    }
  }
  const width = Number(info && info.windowWidth) || 375;
  const statusHeight = readStatusBarHeight(runtime) || 24;
  let menu = null;
  try { menu = runtime && typeof runtime.getMenuButtonBoundingClientRect === 'function' ? runtime.getMenuButtonBoundingClientRect() : null; } catch (_) { /* Preview fallback. */ }
  const validMenu = menu && Number(menu.height) > 0 && Number(menu.top) >= statusHeight && Number(menu.left) > 0 && Number(menu.left) < width;
  const barHeight = Math.ceil(Math.max(58, validMenu ? (Number(menu.top) - statusHeight) * 2 + Number(menu.height) : 44));
  // Content and the native capsule share a row; reserve its entire right-hand area.
  const rightSpace = Math.ceil(validMenu ? width - Number(menu.left) + 12 : 100);
  return { statusHeight: Math.ceil(statusHeight), barHeight, rightSpace };
}

function getSafeTop(api, contentInset) {
  const runtime = api || (typeof wx !== 'undefined' ? wx : null);
  if (!runtime) return 0;

  const statusBarHeight = readStatusBarHeight(runtime);
  const minimumTop = statusBarHeight > 0 ? statusBarHeight + 8 : 0;
  const menuTop = readMenuButtonBottom(runtime);
  const menuSafeTop = menuTop > 0 ? menuTop + 8 : 0;
  // Return only the extra spacer; each page keeps its existing content inset.
  const contentTop = Math.ceil(Math.max(minimumTop, menuSafeTop));
  const existingInset = Number.isFinite(Number(contentInset)) ? Math.max(0, Number(contentInset)) : 17;
  return Math.max(0, contentTop - existingInset);
}

module.exports = { getSafeTop, getNavigationMetrics };

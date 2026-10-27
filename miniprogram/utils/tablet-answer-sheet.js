// The server's six-question free boundary is independent of tablet presentation.
const FREE_PAGE_SIZE = 6;

function viewport(runtime, override) {
  if (override && Number(override.windowWidth) > 0) return override;
  try {
    if (runtime && typeof runtime.getWindowInfo === 'function') return runtime.getWindowInfo();
    if (runtime && typeof runtime.getSystemInfoSync === 'function') return runtime.getSystemInfoSync();
  } catch (_) { /* Keep the phone presentation if viewport information is unavailable. */ }
  return {};
}

function isTablet(runtime, override) {
  return Number(viewport(runtime, override).windowWidth) >= 600;
}

function pageSize(activated, runtime, override) {
  const info = viewport(runtime, override);
  if (!activated || Number(info.windowWidth) < 600 || !Number(info.windowWidth)) return FREE_PAGE_SIZE;
  const height = Number(info.windowHeight) || 0;
  return height >= 1200 ? 24 : height >= 900 ? 18 : 12;
}

function resizedViewport(runtime, previous, event) {
  const next = event && event.size;
  const before = viewport(runtime, previous);
  if (!next || !Number(next.windowWidth) || Number(before.windowWidth) === Number(next.windowWidth)) return null;
  // Keyboard height changes must not re-page a sheet while the user is typing.
  if (Number(before.windowWidth) < 600 && Number(next.windowWidth) < 600) return null;
  return next;
}

module.exports = { FREE_PAGE_SIZE, viewport, isTablet, pageSize, resizedViewport };

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function revealGeometry(event, info, scrollTop) {
  const width = Number(info.windowWidth) || 375;
  const height = Number(info.windowHeight) || 667;
  const touch = event && ((event.changedTouches || [])[0] || (event.touches || [])[0]);
  const detail = event && event.detail || {};
  const xValue = touch && finite(touch.clientX) ? touch.clientX
    : touch && finite(touch.pageX) ? touch.pageX : detail.x;
  const yValue = touch && finite(touch.clientY) ? touch.clientY
    : touch && finite(touch.pageY) ? Number(touch.pageY) - scrollTop
      : finite(detail.y) ? Number(detail.y) - scrollTop : undefined;
  const x = Math.max(0, Math.min(width, finite(xValue) ? Number(xValue) : width / 2));
  const y = Math.max(0, Math.min(height, finite(yValue) ? Number(yValue) : height / 2));
  return { x, y, radius: Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y))) };
}

module.exports = { revealGeometry };

const MIN_SWIPE_X = 64;
const MAX_SWIPE_Y = 48;

function firstTouch(list) {
  return list && list.length ? list[0] : null;
}

function start(event) {
  const touch = firstTouch(event && (event.touches || event.changedTouches));
  const x = Number(touch && touch.clientX);
  const y = Number(touch && touch.clientY);
  if (!touch || !Number.isFinite(x) || !Number.isFinite(y)) {
    this._pageSwipeStart = null;
    return;
  }
  const target = event && event.target;
  const dataset = target && target.dataset || {};
  this._pageSwipeStart = {
    x,
    y,
    ignored: Boolean(dataset.id || dataset.swipeIgnore)
  };
}

function end(event, previous, next) {
  const startPoint = this._pageSwipeStart;
  this._pageSwipeStart = null;
  const touch = firstTouch(event && (event.changedTouches || event.touches));
  if (!startPoint || startPoint.ignored || !touch) return;
  const x = Number(touch.clientX);
  const y = Number(touch.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const deltaX = x - startPoint.x;
  const deltaY = y - startPoint.y;
  if (Math.abs(deltaX) < MIN_SWIPE_X || Math.abs(deltaY) > MAX_SWIPE_Y || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
  return deltaX < 0 ? next() : previous();
}

module.exports = { start, end };

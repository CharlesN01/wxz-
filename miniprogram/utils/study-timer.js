// One foreground learning clock for all pages. Failed packets retain their sequence.
function createStudyTimer(options) {
  const now = options.now || Date.now;
  const schedule = options.schedule || ((fn) => setInterval(fn, 1000));
  const cancel = options.cancel || clearInterval;
  let foreground = true;
  let visiblePage = null;
  let active = null;
  let interval = null;
  let blocked = null;
  const sessions = new Set();

  function identity() {
    const value = options.getSession();
    return value && value.token && value.user && value.user.id ? String(value.user.id) : '';
  }

  function ready() {
    return foreground && visiblePage && visiblePage.ready() && identity();
  }

  function ensureInterval() {
    if (interval === null && foreground && (active || sessions.size)) interval = schedule(tick);
    if (interval !== null && (!foreground || (!active && !sessions.size))) {
      cancel(interval);
      interval = null;
    }
  }

  function sample(session) {
    const stamp = now();
    if (session.anchored && !session.failed && session === active) {
      // A suspended runtime must not turn a long clock gap into study time.
      const delta = stamp - session.sampledAt;
      if (delta >= 0 && delta <= 5000) session.pendingMs += delta;
    }
    session.sampledAt = Math.max(session.sampledAt, stamp);
  }

  function enqueue(session, force) {
    const seconds = Math.floor(session.pendingMs / 1000);
    if (seconds < (force ? 1 : 30)) return;
    const elapsed = Math.min(seconds, 60);
    session.pendingMs -= elapsed * 1000;
    session.queue.push({ sessionId: session.id, sequence: session.sequence++, elapsedSeconds: elapsed });
  }

  function pump(session) {
    if (session.sending || !session.queue.length || session.retryAt > now()) return;
    // Never send an old user's packet with a new user's Bearer token.
    if (identity() !== session.account) {
      sessions.delete(session);
      if (active === session) active = null;
      return;
    }
    const packet = session.queue[0];
    session.sending = true;
    session.promise = Promise.resolve().then(() => {
      if (identity() !== session.account) throw { status: 401 };
      return options.send(packet, { idempotencyKey: 'study-' + session.id + '-' + packet.sequence, retryAuth: false, timeout: 5000 });
    }).then(() => {
      session.queue.shift();
      session.sending = false;
      session.anchored = true;
      if (session.failed || packet.sequence === 0) session.sampledAt = Math.max(session.sampledAt, now());
      session.failed = false;
      session.attempts = 0;
      if (session.closed && !session.queue.length) sessions.delete(session);
      else pump(session);
      ensureInterval();
    }, (error) => {
      session.sending = false;
      session.failed = true;
      session.attempts += 1;
      session.retryAt = now() + Math.min(60000, 5000 * Math.pow(2, Math.min(session.attempts - 1, 4)));
      const status = error && error.status;
      if (status >= 400 && status < 500 && status !== 429) {
        sessions.delete(session);
        if (active === session) { active = null; blocked = { account: session.account, page: session.page }; }
      }
      ensureInterval();
    });
  }

  function close() {
    if (!active) return;
    sample(active);
    enqueue(active, true);
    active.closed = true;
    const closing = active;
    active = null;
    if (!closing.queue.length && !closing.sending) sessions.delete(closing);
    else pump(closing);
  }

  function sync() {
    const account = ready();
    if (blocked && (identity() !== blocked.account || !visiblePage || visiblePage.page !== blocked.page)) blocked = null;
    if (active && (!account || active.account !== account)) close();
    if (account && !active && !blocked) {
      const id = options.newId();
      active = { id, account, page: visiblePage.page, sampledAt: now(), pendingMs: 0, sequence: 1,
        anchored: false, failed: false, sending: false, closed: false,
        retryAt: 0, attempts: 0, queue: [{ sessionId: id, sequence: 0, elapsedSeconds: 0 }] };
      sessions.add(active);
      pump(active);
    }
    ensureInterval();
  }

  function tick() {
    sync();
    if (active) { sample(active); enqueue(active, false); }
    sessions.forEach(pump);
  }

  return {
    enter(page, check) {
      if (visiblePage && visiblePage.page !== page) close();
      visiblePage = { page, ready: () => check(page) };
      sync();
    },
    update(page) { if (visiblePage && visiblePage.page === page) sync(); },
    leave(page) {
      if (!visiblePage || visiblePage.page !== page) return;
      close(); visiblePage = null; blocked = null; ensureInterval();
    },
    onAppHide() { close(); foreground = false; ensureInterval(); },
    onAppShow() { foreground = true; sync(); sessions.forEach(pump); },
    tick,
    flush() { if (active) { sample(active); enqueue(active, true); pump(active); } },
    // Wait for the final page heartbeat before reading updated home statistics.
    async settled(timeoutMs = 1500) {
      this.flush();
      let timeout;
      const drain = async () => {
        for (let remaining = 5; remaining > 0; remaining -= 1) {
          const pending = [];
          sessions.forEach((session) => { if (session.sending) pending.push(session.promise); });
          if (!pending.length) return;
          await Promise.all(pending);
        }
      };
      try {
        await Promise.race([drain(), new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); })]);
      } finally { clearTimeout(timeout); }
    }
  };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

const clock = createStudyTimer({
  getSession: () => require('./session').getSession(),
  send: (packet, options) => require('../services/api').learning.studyTime(packet, options),
  newId: uuid
});

function questionReady(page) {
  const data = page.data;
  return !data.loading && !data.hasError && data.dataSource === 'remote'
    && (data.questions || []).some((question) => !question.unavailable);
}

function withStudyTime(definition, check) {
  const ready = check || questionReady;
  const load = definition.onLoad;
  const show = definition.onShow;
  const hide = definition.onHide;
  const unload = definition.onUnload;
  return Object.assign({}, definition, {
    onLoad(...args) {
      const setData = this.setData;
      this.setData = function (...values) {
        const result = setData.apply(this, values);
        clock.update(this);
        return result;
      };
      if (load) return load.apply(this, args);
    },
    onShow(...args) {
      const result = show && show.apply(this, args);
      clock.enter(this, ready);
      return result;
    },
    onHide(...args) { clock.leave(this); if (hide) return hide.apply(this, args); },
    onUnload(...args) { clock.leave(this); if (unload) return unload.apply(this, args); }
  });
}

module.exports = { createStudyTimer, withStudyTime, clock };

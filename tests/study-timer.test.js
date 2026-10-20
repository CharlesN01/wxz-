const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createStudyTimer } = require('../miniprogram/utils/study-timer');

const drain = () => new Promise((resolve) => setImmediate(resolve));
const authenticated = (id = 'student-a', token = 'test-token') => ({ token, user: { id } });
const readyPage = () => ({ data: { loading: false, hasError: false, dataSource: 'remote', questions: [{ id: 'q-1' }] } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(sendHook, session = authenticated()) {
  let stamp = 0;
  let nextId = 0;
  let currentSession = session;
  const scheduled = new Map();
  const calls = [];
  const successful = [];
  const dependencies = {
    now: () => stamp,
    getSession: () => currentSession,
    schedule(fn) { const id = ++nextId; scheduled.set(id, fn); return id; },
    cancel: (id) => scheduled.delete(id),
    newId: () => `session-${++nextId}`,
    send(packet, options) {
      const call = { packet: { ...packet }, options: { ...options }, account: currentSession && currentSession.user.id };
      calls.push(call);
      return Promise.resolve(sendHook && sendHook(call, calls.length)).then(() => { successful.push(call); });
    }
  };
  const timer = createStudyTimer(dependencies);
  return {
    timer, calls, successful, scheduled, dependencies,
    setSession(value) { currentSession = value; },
    jump(milliseconds) { stamp += milliseconds; },
    async seconds(seconds) {
      for (let index = 0; index < seconds; index += 1) {
        stamp += 1000;
        timer.tick();
        await drain();
      }
    },
    elapsed() { return successful.reduce((total, call) => total + call.packet.elapsedSeconds, 0); }
  };
}

test('前台学习按秒累计，进入后台和无可见页面时停止计时', async () => {
  const f = fixture();
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(12);
  f.timer.onAppHide();
  await f.timer.settled();
  assert.equal(f.elapsed(), 12);
  assert.equal(f.scheduled.size, 0);

  f.jump(60_000);
  f.timer.tick();
  await drain();
  assert.equal(f.elapsed(), 12);
  f.timer.onAppShow();
  await drain();
  await f.seconds(8);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 20);
  assert.equal(new Set(f.calls.map((call) => call.packet.sessionId)).size, 2);
  await f.seconds(10);
  assert.equal(f.elapsed(), 20);
});

test('切换学习页先结束上一页，迟到的旧页hide不关闭新页或重复计时', async () => {
  const f = fixture();
  const first = readyPage();
  const second = readyPage();
  f.timer.enter(first, () => true);
  await drain();
  await f.seconds(10);
  f.timer.enter(second, () => true);
  f.timer.leave(first);
  await drain();
  await f.seconds(7);
  f.timer.leave(second);
  await f.timer.settled();
  assert.equal(f.elapsed(), 17);
  assert.deepEqual(f.successful.filter((call) => call.packet.elapsedSeconds).map((call) => call.packet.elapsedSeconds), [10, 7]);
  assert.equal(f.scheduled.size, 0);
});

test('真实页面装饰器排除加载、错误、空集、全受限、演示数据和游客', async () => {
  const f = fixture();
  const filename = path.join(__dirname, '..', 'miniprogram/utils/study-timer.js');
  const context = { module: { exports: {} }, Date: { now: f.dependencies.now }, setInterval: f.dependencies.schedule,
    clearInterval: f.dependencies.cancel, setTimeout, clearTimeout, Math, Promise,
    require(name) {
      if (name === './session') return { getSession: f.dependencies.getSession };
      if (name === '../services/api') return { learning: { studyTime: f.dependencies.send } };
      throw new Error(`Unexpected dependency ${name}`);
    } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const runtime = context.module.exports;
  const definition = runtime.withStudyTime({});
  const page = {
    data: { loading: true, dataSource: 'remote', questions: [] },
    setData(value) { Object.assign(this.data, value); }
  };
  definition.onLoad.call(page);
  definition.onShow.call(page);
  f.jump(2000);
  runtime.clock.tick();
  await drain();
  assert.equal(f.calls.length, 0, '登录账号的加载阶段不发送计时锚点');
  assert.equal(f.scheduled.size, 0, '加载阶段不启动无用的全局轮询');
  const invalid = [
    { loading: false, questions: [] },
    { questions: [{ unavailable: true }] },
    { questions: [{ id: 'valid' }], hasError: true },
    { hasError: false, dataSource: 'local' }
  ];
  for (const values of invalid) {
    page.setData(values);
    f.jump(2000);
    runtime.clock.tick();
    await drain();
    assert.equal(f.calls.length, 0, '登录账号无可学习内容时不发送计时锚点');
    assert.equal(f.scheduled.size, 0, '无可学习内容时不启动无用的全局轮询');
  }
  f.setSession(null);
  page.setData({ dataSource: 'remote' });
  f.jump(2000);
  runtime.clock.tick();
  await drain();
  assert.equal(f.calls.length, 0, '游客或尚无可学内容时连锚点也不发送');
  assert.equal(f.scheduled.size, 0, '游客不启动全局计时轮询');
  f.setSession(authenticated());
  page.setData({});
  await drain();
  for (let index = 0; index < 5; index += 1) { f.jump(1000); runtime.clock.tick(); await drain(); }
  page.setData({ loading: true });
  await runtime.clock.settled();
  assert.equal(f.elapsed(), 5);
  assert.equal(f.scheduled.size, 0, '重新加载时结束最后心跳后停止轮询');
  definition.onHide.call(page);
});

test('初次锚点请求确认前不累计等待时间', async () => {
  const anchor = deferred();
  const f = fixture((call) => call.packet.sequence === 0 ? anchor.promise : undefined);
  const page = readyPage();
  f.timer.enter(page, () => true);
  await f.seconds(4);
  assert.equal(f.calls.length, 1);
  anchor.resolve();
  await drain();
  await f.seconds(3);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 3);
});

test('创建请求后的微任务内切换账号，不会用新账号发送旧账号锚点', async () => {
  const f = fixture();
  f.timer.enter(readyPage(), () => true);
  f.setSession(authenticated('student-b'));
  f.timer.tick();
  await drain();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].account, 'student-b');
  assert.notEqual(f.calls[0].packet.sessionId, 'session-1');
  f.timer.onAppHide();
  await f.timer.settled();
});

test('旧账号失败待重试包在切换账号后丢弃，同账号刷新token不重开计时段', async () => {
  const f = fixture((call) => {
    if (call.account === 'student-a' && call.packet.sequence === 1) return Promise.reject({ status: 503 });
  });
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(30);
  const oldSession = f.calls[0].packet.sessionId;
  f.setSession(authenticated('student-b'));
  f.timer.tick();
  await drain();
  await f.seconds(6);
  f.setSession(authenticated('student-b', 'refreshed-test-token'));
  f.timer.update(page);
  await f.seconds(2);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.calls.filter((call) => call.packet.sessionId === oldSession && call.packet.sequence === 1).length, 1);
  assert.ok(f.calls.filter((call) => call.packet.sessionId === oldSession).every((call) => call.account === 'student-a'));
  assert.equal(f.calls.filter((call) => call.account === 'student-b' && call.packet.sequence === 0).length, 1);
  assert.equal(f.successful.filter((call) => call.account === 'student-b').reduce((sum, call) => sum + call.packet.elapsedSeconds, 0), 8);
});

test('失败包保留sequence和幂等键，冷却后重试且等待期间不计时', async () => {
  let failed = false;
  const f = fixture((call) => {
    if (call.packet.sequence === 1 && !failed) { failed = true; return Promise.reject({ status: 503 }); }
  });
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(30);
  const first = f.calls.find((call) => call.packet.sequence === 1);
  await f.seconds(4);
  assert.equal(f.calls.filter((call) => call.packet.sequence === 1).length, 1);
  await f.seconds(1);
  const retried = f.calls.filter((call) => call.packet.sequence === 1);
  assert.equal(retried.length, 2);
  assert.deepEqual(retried[1].packet, first.packet);
  assert.equal(retried[1].options.idempotencyKey, first.options.idempotencyKey);
  await f.seconds(3);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 33);
  assert.equal(f.successful.filter((call) => call.packet.sequence === 1).length, 1);
});

test('运行时挂起的大时间跳跃不会变成学习时长，恢复后重新逐秒累计', async () => {
  const f = fixture();
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(3);
  f.jump(120_000);
  f.timer.tick();
  await drain();
  await f.seconds(4);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 7);
});

test('settled等待离页时已排队的最后心跳，不能在前一包完成时提前返回', async () => {
  const first = deferred();
  const final = deferred();
  const f = fixture((call) => call.packet.sequence === 1 ? first.promise : call.packet.sequence === 2 ? final.promise : undefined);
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(35);
  f.timer.leave(page);
  let completed = false;
  const waiting = f.timer.settled().then(() => { completed = true; });
  await drain();
  assert.equal(completed, false);
  first.resolve();
  await drain();
  assert.equal(completed, false);
  assert.equal(f.calls.find((call) => call.packet.sequence === 2).packet.elapsedSeconds, 5);
  final.resolve();
  await waiting;
  assert.equal(completed, true);
  assert.equal(f.elapsed(), 35);
});

for (const status of [400, 401, 403, 409]) {
  test(`永久 ${status} 错误熔断当前页面和账号，后续tick或重渲染不反复发请求`, async () => {
    const f = fixture((call) => call.account === 'student-a' ? Promise.reject({ status }) : undefined);
    const page = readyPage();
    f.timer.enter(page, () => true);
    await drain();
    await f.seconds(120);
    f.timer.update(page);
    f.timer.enter(page, () => true);
    await drain();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.retryAuth, false);
    assert.equal(f.scheduled.size, 0, '永久错误熔断后停止无用轮询');

    f.setSession(authenticated('student-b'));
    f.timer.update(page);
    await drain();
    await f.seconds(2);
    f.timer.leave(page);
    await f.timer.settled();
    assert.equal(f.calls.filter((call) => call.account === 'student-b' && call.packet.sequence === 0).length, 1);
    assert.equal(f.elapsed(), 2);
  });
}

test('永久错误只熔断发生错误的当前页面，离开重进可重新建立计时段', async () => {
  let first = true;
  const f = fixture(() => {
    if (first) { first = false; return Promise.reject({ status: 403 }); }
  });
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(10);
  assert.equal(f.calls.length, 1);
  f.timer.leave(page);
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(2);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.calls.filter((call) => call.packet.sequence === 0).length, 2);
  assert.equal(f.elapsed(), 2);
});

for (const [description, error] of [['断网', { network: true }], ['503', { status: 503 }], ['429', { status: 429 }]]) {
  test(`${description} 失败不丢离页队列，按5/10/20/40/60秒封顶重试原包`, async () => {
    let attempts = 0;
    const f = fixture((call) => {
      if (call.packet.sequence === 1 && ++attempts <= 7) return Promise.reject(error);
    });
    const page = readyPage();
    f.timer.enter(page, () => true);
    await drain();
    await f.seconds(30);
    f.timer.leave(page);
    await drain();
    const initial = f.calls.find((call) => call.packet.sequence === 1);
    assert.equal(attempts, 1);
    for (const interval of [5, 10, 20, 40, 60, 60, 60]) {
      const before = attempts;
      await f.seconds(interval - 1);
      assert.equal(attempts, before, `退避 ${interval} 秒前不提前重发`);
      await f.seconds(1);
      assert.equal(attempts, before + 1);
    }
    await f.timer.settled();
    const retries = f.calls.filter((call) => call.packet.sequence === 1);
    assert.equal(retries.length, 8);
    for (const call of retries) {
      assert.deepEqual(call.packet, initial.packet);
      assert.equal(call.options.idempotencyKey, initial.options.idempotencyKey);
      assert.equal(call.options.retryAuth, false);
    }
    assert.equal(f.calls.filter((call) => call.packet.sequence === 0).length, 1);
    assert.equal(f.elapsed(), 30);
    assert.equal(f.scheduled.size, 0);
  });
}

test('系统时间回拨不倒退采样基线，追平旧时刻以前不重复累计', async () => {
  const f = fixture();
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(3);
  f.jump(-2000);
  f.timer.tick();
  await drain();
  await f.seconds(2);
  await f.seconds(1);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 4, '回拨后重复经过的两秒不应再次算学习时长');
});

test('同页面同账号的loading切换不解除永久错误熔断', async () => {
  const f = fixture(() => Promise.reject({ status: 403 }));
  const page = readyPage();
  f.timer.enter(page, (value) => !value.data.loading);
  await drain();
  page.data.loading = true;
  f.timer.update(page);
  page.data.loading = false;
  f.timer.update(page);
  await drain();
  await f.seconds(10);
  assert.equal(f.calls.length, 1);
  f.timer.leave(page);
});

test('重试应答期间发生时钟回拨，也不能让成功回调倒退采样基线', async () => {
  const retry = deferred();
  let attempts = 0;
  const f = fixture((call) => {
    if (call.packet.sequence !== 1) return undefined;
    attempts += 1;
    return attempts === 1 ? Promise.reject({ status: 503 }) : retry.promise;
  });
  const page = readyPage();
  f.timer.enter(page, () => true);
  await drain();
  await f.seconds(35);
  assert.equal(attempts, 2);
  f.jump(-10_000);
  retry.resolve();
  await drain();
  await f.seconds(11);
  f.timer.leave(page);
  await f.timer.settled();
  assert.equal(f.elapsed(), 31);
});

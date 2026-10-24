const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const storage = new Map();
global.wx = {
  getStorageSync: k => storage.get(k),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: k => storage.delete(k),
  clearStorage: () => storage.clear()
};

const agentAttribution = require('../miniprogram/utils/agent-attribution');

describe('agent-attribution', () => {
  beforeEach(() => { storage.clear(); });

  it('扫普通小程序码时，scene 在 App onLaunch 的 options.query.scene', () => {
    const scene = agentAttribution.capture({ query: { scene: 'a%3DTEST' } });
    assert.equal(scene, 'a=TEST');
    assert.equal(agentAttribution.read(), 'a=TEST');
  });

  it('扫普通小程序码时，scene 在页面 onLoad 的 options.scene（平铺）', () => {
    const scene = agentAttribution.capture({ scene: 'a%3DTEST123' });
    assert.equal(scene, 'a=TEST123');
    assert.equal(agentAttribution.read(), 'a=TEST123');
  });

  it('微信会对 scene 值做 URL 编码，capture 会自动解码', () => {
    const scene = agentAttribution.capture({ scene: 'a%3DAGENT_CODE-01' });
    assert.equal(scene, 'a=AGENT_CODE-01');
  });

  it('无效 scene 不会被存储', () => {
    agentAttribution.capture({ scene: 'invalid' });
    assert.equal(agentAttribution.read(), '');
  });

  it('scene 格式要求：a= 开头，后接 3-32 个字母数字下划线连字符', () => {
    assert.equal(agentAttribution.normalize('a=AB'), '');  // 太短
    assert.equal(agentAttribution.normalize('a=ABC'), 'a=ABC');
    assert.equal(agentAttribution.normalize('a=ABC-123_XYZ'), 'a=ABC-123_XYZ');
    assert.equal(agentAttribution.normalize('a=' + 'X'.repeat(32)), 'a=' + 'X'.repeat(32));
    assert.equal(agentAttribution.normalize('a=' + 'X'.repeat(33)), '');  // 太长
  });

  it('scene 保存后 30 天有效，过期自动清除', () => {
    const now = Date.now;
    Date.now = () => 1000000;
    agentAttribution.capture({ scene: 'a%3DTEST' });
    Date.now = () => 1000000 + 29 * 86400000;
    assert.equal(agentAttribution.read(), 'a=TEST');
    Date.now = () => 1000000 + 31 * 86400000;
    assert.equal(agentAttribution.read(), '');
    Date.now = now;
  });

  it('capture 无参数时返回已保存的 scene', () => {
    agentAttribution.capture({ scene: 'a%3DFIRST' });
    const scene = agentAttribution.capture(null);
    assert.equal(scene, 'a=FIRST');
  });

  it('新 scene 会覆盖旧 scene', () => {
    agentAttribution.capture({ scene: 'a%3DFIRST' });
    agentAttribution.capture({ scene: 'a%3DSECOND' });
    assert.equal(agentAttribution.read(), 'a=SECOND');
  });
});

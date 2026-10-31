const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { resourceImageUrl, retryImageUrl } = require('../miniprogram/utils/resource-image');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'resources', 'index.js');
const templatePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'resources', 'index.wxml');

function createPage(response, options) {
  let definition;
  const calls = { preview: [], clipboard: [], toast: [] };
  const api = {
    resources: {
      group: options && options.reject
        ? () => Promise.reject(options.reject)
        : () => Promise.resolve(response)
    }
  };
  const wx = {
    previewImage(value) { calls.preview.push(value); },
    setClipboardData(value) { calls.clipboard.push(value); value.success(); },
    showToast(value) { calls.toast.push(value); }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../services/api') return api;
      if (name === '../../utils/resource-image') return require('../miniprogram/utils/resource-image');
      if (name === '../../utils/agent-attribution') return { read: () => '', sharePath: (value) => value, shareQuery: () => '' };
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: Object.assign({}, definition.data),
    setData(value) { Object.assign(this.data, value); }
  };
  return { page, calls };
}

test('资料群配置关闭或缺失时仍保留原型主体，二维码与口令显示空态', async () => {
  const { page, calls } = createPage({ enabled: false, groupQrCode: 'https://example.test/qr.png', claimCode: 'SECRET' });
  await page.load();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.canCopy, false);
  assert.equal(page.data.qrCode, '');
  assert.equal(page.data.copyButtonText, '领取口令暂未配置');
  page.copyCode();
  page.previewQr();
  assert.equal(calls.clipboard.length, 0);
  assert.deepEqual(calls.toast.map((item) => item.title), ['暂无领取口令', '二维码暂未配置']);

  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /class="benefits"/);
  assert.match(template, /文学常识重点梳理/);
  assert.match(template, /文言文25篇复习资料/);
  assert.match(template, /专升本语文备考提醒/);
  assert.match(template, /class="qr-placeholder"/);
  assert.match(template, /免费领取/);
  assert.match(template, /资料持续更新/);
  assert.doesNotMatch(template, /资料领取暂未开放|资料领取配置暂未发布/);
});

test('已开放配置时仅使用接口二维码和口令，支持预览与复制', async () => {
  const { page, calls } = createPage({
    enabled: true,
    groupQrCode: 'https://example.test/group.png',
    wechatId: 'wechat-demo',
    claimCode: '领取口令',
    description: '接口说明',
    announcement: '公告'
  });
  await page.load();

  assert.equal(page.data.qrCode, 'https://example.test/group.png');
  assert.equal(page.data.canCopy, true);
  assert.equal(page.data.copyButtonText, '复制领取口令：领取口令');
  assert.equal(page.data.qrDescription, '接口说明');
  assert.equal(page.data.wechatId, 'wechat-demo');
  assert.equal(page.data.announcement, '公告');

  page.previewQr();
  page.copyCode();
  assert.equal(calls.preview.length, 1);
  assert.equal(calls.preview[0].urls[0], 'https://example.test/group.png');
  assert.equal(calls.clipboard[0].data, '领取口令');
  assert.equal(page.data.copied, true);
});

test('资料接口失败时保留可见主体并提供重试错误态', async () => {
  const { page } = createPage(null, { reject: new Error('网络不可用') });
  await page.load();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '网络不可用');
  assert.equal(page.data.qrCode, '');
  assert.equal(page.data.canCopy, false);
});

test('资料图片相对路径补全API地址，同站HTTP升级HTTPS，非法来源关闭显示', () => {
  assert.equal(resourceImageUrl('/media/resources/group/test.png'), 'https://zsbzy.com/media/resources/group/test.png');
  assert.equal(resourceImageUrl('media/resources/group/test.png'), 'https://zsbzy.com/media/resources/group/test.png');
  assert.equal(resourceImageUrl('http://zsbzy.com/media/qr.png'), 'https://zsbzy.com/media/qr.png');
  assert.equal(resourceImageUrl('https://cdn.example.test/qr.png'), 'https://cdn.example.test/qr.png');
  assert.equal(resourceImageUrl('http://127.0.0.1/media/qr.png'), '');
  assert.equal(resourceImageUrl('javascript:alert(1)'), '');
  assert.equal(resourceImageUrl('https://name:secret@example.test/qr.png'), '');
  assert.equal(retryImageUrl('/media/qr.png', 123), 'https://zsbzy.com/media/qr.png?qr_retry=123');
});

test('二维码404或加载失败显示明确错误，重试重新读配置并刷新图片缓存', async () => {
  const { page, calls } = createPage({ enabled: true, groupQrCode: '/media/resources/group/qr.png' });
  await page.load();
  assert.equal(page.data.qrLoading, true);
  page.onQrError({ currentTarget: { dataset: { source: page.data.qrCode } } });
  assert.equal(page.data.qrLoading, false);
  assert.match(page.data.qrError, /图片加载失败.*点击重试/);
  assert.equal(calls.preview.length, 0);
  await page.retryQr();
  assert.equal(page.data.qrError, '');
  assert.match(page.data.qrCode, /^https:\/\/zsbzy\.com\/media\/resources\/group\/qr\.png\?qr_retry=/);
  page.onQrLoad({ currentTarget: { dataset: { source: page.data.qrCode } } });
  assert.equal(page.data.qrLoading, false);
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /wx:if="\{\{qrError\}\}"[^>]*bindtap="retryQr"/);
  assert.match(template, /bindload="onQrLoad" binderror="onQrError"/);
});

test('旧图片延迟回调不覆盖新图片状态，无效二维码地址有明确配置错误', async () => {
  const { page } = createPage({ enabled: true, groupQrCode: 'http://localhost:8000/media/qr.png' });
  await page.load();
  assert.equal(page.data.qrCode, '');
  assert.match(page.data.qrError, /地址不可用/);
  page.setData({ qrCode: 'https://zsbzy.com/media/new.png', qrLoading: true, qrError: '' });
  page.onQrError({ currentTarget: { dataset: { source: 'https://zsbzy.com/media/old.png' } } });
  assert.equal(page.data.qrLoading, true);
  assert.equal(page.data.qrError, '');
});

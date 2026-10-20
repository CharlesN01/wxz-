const apiConfig = require('../services/api-config');

function resourceImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const base = /^((https?):\/\/[^/?#]+)/i.exec(apiConfig.getApiBaseUrl());
  if (!base) return '';
  let target = raw;
  if (target.startsWith('//')) target = base[2] + ':' + target;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(target)) target = base[1] + '/' + target.replace(/^\/+/, '');
  const url = /^(https?):\/\/([^/?#@]+)(\/[^#]*)?$/i.exec(target);
  if (!url) return '';
  if (base[2].toLowerCase() === 'https' && url[1].toLowerCase() === 'http') {
    if (url[2].toLowerCase() !== base[1].slice(base[1].indexOf('://') + 3).toLowerCase()) return '';
    target = target.replace(/^http:/i, 'https:');
  }
  return target;
}

function retryImageUrl(value, nonce) {
  const url = resourceImageUrl(value);
  if (!url) return '';
  return url + (url.includes('?') ? '&' : '?') + 'qr_retry=' + encodeURIComponent(String(nonce === undefined ? Date.now() : nonce));
}

module.exports = { resourceImageUrl, retryImageUrl };

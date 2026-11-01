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
  const baseHost = base[1].slice(base[1].indexOf('://') + 3).toLowerCase();
  const targetHost = url[2].toLowerCase();
  // Older records may contain the apex hostname while production now uses
  // the canonical www hostname. Treat the two as the same media origin.
  const sameMediaOrigin = targetHost === baseHost ||
    (baseHost === 'www.zsbzy.com' && targetHost === 'zsbzy.com');
  if (base[2].toLowerCase() === 'https' && url[1].toLowerCase() === 'http') {
    if (!sameMediaOrigin) return '';
    target = target.replace(/^http:/i, 'https:');
  }
  if (sameMediaOrigin && targetHost !== baseHost) {
    target = target.replace(/^(https?:\/\/)[^/?#]+/i, '$1' + baseHost);
  }
  return target;
}

function retryImageUrl(value, nonce) {
  const url = resourceImageUrl(value);
  if (!url) return '';
  return url + (url.includes('?') ? '&' : '?') + 'qr_retry=' + encodeURIComponent(String(nonce === undefined ? Date.now() : nonce));
}

module.exports = { resourceImageUrl, retryImageUrl };

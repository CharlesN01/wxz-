Component({
  properties: { name: { type: String, value: 'book' }, size: { type: Number, value: 52 }, color: { type: String, value: '' } },
  data: { iconSource: '/assets/icons/book.png', iconStyle: '' },
  observers: {
    'name, color, size'(name, color, size) {
      const variants = {
        '#1B5E91': 'green', '#3A86B9': 'green', '#E49A48': 'amber',
        '#12345B': 'green', '#1B4D3E': 'green', '#C47A2B': 'amber',
        '#FFFFFF': 'white', '#607184': 'muted', '#5C6460': 'muted'
      };
      const suffix = variants[String(color || '').toUpperCase()];
      const blue = ['#1B5E91', '#3A86B9', '#12345B'].indexOf(String(color || '').toUpperCase()) !== -1;
      let tablet = false;
      try {
        const info = typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function'
          ? wx.getWindowInfo()
          : (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null);
        tablet = Boolean(info && Number(info.windowWidth || info.screenWidth) >= 600);
      } catch (_) { /* Keep the phone unit when viewport information is unavailable. */ }
      const numericSize = Number(size) || 0;
      const unit = tablet ? (numericSize * 0.625) + 'px' : numericSize + 'rpx';
      this.setData({
        iconSource: '/assets/icons/' + (name || 'book') + (suffix ? '-' + suffix : '') + '.png',
        iconStyle: 'width: ' + unit + '; height: ' + unit + ';' + (blue ? ' filter: hue-rotate(50deg) saturate(1.05);' : '')
      });
    }
  }
});

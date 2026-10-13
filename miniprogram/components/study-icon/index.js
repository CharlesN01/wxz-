Component({
  properties: { name: { type: String, value: 'book' }, size: { type: Number, value: 52 }, color: { type: String, value: '' } },
  data: { iconSource: '/assets/icons/book.png', iconStyle: '' },
  observers: {
    'name, color'(name, color) {
      const variants = {
        '#1B5E91': 'green', '#3A86B9': 'green', '#E49A48': 'amber',
        '#12345B': 'green', '#1B4D3E': 'green', '#C47A2B': 'amber',
        '#FFFFFF': 'white', '#607184': 'muted', '#5C6460': 'muted'
      };
      const suffix = variants[String(color || '').toUpperCase()];
      const blue = ['#1B5E91', '#3A86B9', '#12345B'].indexOf(String(color || '').toUpperCase()) !== -1;
      this.setData({
        iconSource: '/assets/icons/' + (name || 'book') + (suffix ? '-' + suffix : '') + '.png',
        iconStyle: blue ? 'filter: hue-rotate(50deg) saturate(1.05);' : ''
      });
    }
  }
});

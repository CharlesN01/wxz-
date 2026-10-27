Component({
  properties: {
    visible: { type: Boolean, value: false },
    remainingPages: { type: Number, value: 0 },
    remainingQuestions: { type: Number, value: 0 },
    contextLabel: { type: String, value: '当前答题主题' }
  },
  methods: {
    close() { this.triggerEvent('close'); },
    open() { this.triggerEvent('open'); },
    stopTap() {}
  }
});

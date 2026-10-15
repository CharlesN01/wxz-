const utils = require('../../utils/question-utils');

Component({
  properties: {
    question: { type: Object, value: {} },
    mode: { type: String, value: 'writing' },
    number: { type: Number, value: 1 },
    variant: { type: String, value: 'green' },
    showTag: { type: Boolean, value: false }
  },
  data: { segments: [], isTranslation: false, translationStem: '', translationAnswer: '', wordStem: '', answerVisible: false, answerText: '', draftAnswer: '' },
  observers: {
    'question, mode'(question, mode) {
      const item = question || {};
      const stem = String(item.stem || '');
      const isTranslation = item.type === 'translation';
      const quoted = /^[“「『"]([\s\S]+?)[”」』"]/.exec(stem);
      const translationStem = isTranslation
        ? (quoted ? quoted[1] : stem.split(/\{\{\d+\}\}/)[0].replace(/(?:翻译为|译为|翻译)[：:\s]*$/, ''))
        : '';
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const context = [item.id || stem, mode, this.data.variant || 'green'].join('|');
      const sameContext = this._renderedContext === context;
      this._renderedContext = context;
      // 字词专项和文言随机把含义放到独立答案行，题干保留原句与考点。
      const wordQuestion = /^[“「『"]([\s\S]+?)[”」』"]\s*中[，,]?\s*[“「『"](.+?)[”」』"]/.exec(stem);
      const wordStem = item.type === 'word'
        ? (wordQuestion ? '“' + wordQuestion[1].replace(wordQuestion[2], '（' + wordQuestion[2] + '）') + '”' : stem.replace(/\{\{\d+\}\}/g, '____'))
        : '';
      this.setData({
        segments: utils.segments(stem, answers, mode).map((part) => {
          const text = part.isAnswer ? part.text.slice(1, -1) : part.text;
          return { ...part, text, isBlank: text === '____', compactAnswer: (part.isAnswer && text.length <= 8) || text === '____' };
        }),
        isTranslation,
        translationStem,
        wordStem,
        translationAnswer: isTranslation && mode === 'reciting' ? answers.filter(Boolean).join('；') : '',
        answerVisible: sameContext ? this.data.answerVisible : Boolean(item.answerVisible),
        draftAnswer: sameContext ? this.data.draftAnswer : '',
        answerText: answers.filter(Boolean).join('；')
      });
    }
  },
  methods: {
    favorite() { this.triggerEvent('favorite', { id: this.data.question.id }); },
    master() { this.triggerEvent('master', { id: this.data.question.id }); },
    onDraftInput(event) { this.setData({ draftAnswer: event.detail.value }); },
    toggleAnswer() {
      const reveal = !this.data.answerVisible;
      const update = { answerVisible: reveal };
      if (this.data.variant === 'practice-word') update.draftAnswer = reveal ? this.data.answerText : '';
      this.setData(update);
    }
  }
});

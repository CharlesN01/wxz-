const utils = require('../../utils/question-utils');
const dataService = require('../../services/data-service');

function originLabel(question) {
  const item = question || {};
  const fallback = dataService.getArticleTitle ? dataService.getArticleTitle(item.articleId) : '';
  const title = String(item.articleTitle || fallback || '').trim().replace(/^《|》$/g, '');
  return title ? `《${title}》` : '文言文';
}

function translationPrompt(stem) {
  // Remove only the answer placeholder and its trailing instruction. A quote
  // inside the passage is part of the text, never the end of the passage.
  return stem
    .replace(/(?:翻译为|译为|翻译)[：:\s]*(?:\{\{\d+\}\}\s*)+[。.!！]?\s*$/, '')
    .replace(/\{\{\d+\}\}/g, '')
    .replace(/(?:翻译为|译为|翻译)[：:\s]*$/, '')
    .trim();
}

Component({
  properties: {
    question: { type: Object, value: {} },
    mode: { type: String, value: 'writing' },
    number: { type: Number, value: 1 },
    variant: { type: String, value: 'green' },
    showTag: { type: Boolean, value: false }
  },
  data: { segments: [], isTranslation: false, translationStem: '', translationAnswer: '', wordStem: '', isWordExplanation: false, standaloneAnswer: false, answerVisible: false, answerText: '', originLabel: '', draftAnswers: [] },
  observers: {
    'question, mode'(question, mode) {
      const item = question || {};
      if (item.locked) {
        this._questionKey = null; this._renderKey = null;
        this.setData({ segments: [], translationStem: '', translationAnswer: '', wordStem: '', answerText: '', draftAnswers: [], answerVisible: false });
        return;
      }
      const stem = String(item.stem || '');
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const questionKey = JSON.stringify([String(item.id || stem), item.revision == null ? null : String(item.revision)]);
      const sameQuestion = this._questionKey === questionKey;
      const providedDraft = Array.isArray(item.draftAnswers) ? item.draftAnswers : null;
      const providedKey = providedDraft ? JSON.stringify(providedDraft) : null;
      const sourceDraft = !sameQuestion || providedDraft && providedKey !== this._providedDraftKey
        ? providedDraft
        : this.data.draftAnswers;
      const draftAnswers = utils.normalizeDraftAnswers(item, sourceDraft);
      const renderKey = JSON.stringify([questionKey, stem, answers, item.type, mode]);
      const update = {};
      const label = originLabel(item);
      if (label !== this.data.originLabel) update.originLabel = label;

      // Favorite/mastered changes replace question objects. Keep the existing
      // input nodes and values when their content has not changed.
      if (this._renderKey !== renderKey) {
        const isTranslation = item.type === 'translation';
        const wordQuestion = /^[“「『"]([\s\S]+?)[”」』"]\s*中[，,]?\s*[“「『"](.+?)[”」』"]\s*的?(?:意思|含义|意义|解释)(?:是|为)?[：:\s]*\{\{0\}\}[。.!！]?\s*$/.exec(stem);
        const isWordExplanation = item.type === 'word' && Boolean(wordQuestion);
        const parts = utils.segments(stem, answers, mode).map((part) => ({ ...part, text: part.isAnswer ? part.text.slice(1, -1) : part.text }));
        Object.assign(update, {
          segments: parts,
          isTranslation,
          translationStem: isTranslation ? translationPrompt(stem) : '',
          translationAnswer: isTranslation && mode === 'reciting' ? answers.filter((answer) => answer !== undefined && answer !== null).join('；') : '',
          isWordExplanation,
          wordStem: isWordExplanation ? '“' + wordQuestion[1].replace(wordQuestion[2], '（' + wordQuestion[2] + '）') + '”' : '',
          standaloneAnswer: !isTranslation && !isWordExplanation && !/\{\{\d+\}\}/.test(stem) && utils.requiredAnswerIndices(item).length > 0,
          answerText: answers.filter((answer) => answer !== undefined && answer !== null).join('；')
        });
      }
      if (!sameQuestion) update.answerVisible = Boolean(item.answerVisible);
      if (JSON.stringify(draftAnswers) !== JSON.stringify(this.data.draftAnswers)) update.draftAnswers = draftAnswers;
      this._questionKey = questionKey;
      this._renderKey = renderKey;
      this._providedDraftKey = providedKey;
      if (Object.keys(update).length) this.setData(update);
    }
  },
  methods: {
    favorite() { if (this.data.question.locked) return this.unlock(); this.triggerEvent('favorite', { id: this.data.question.id }); },
    master() { if (this.data.question.locked) return this.unlock(); this.triggerEvent('master', { id: this.data.question.id }); },
    onDraftInput(event) {
      if (this.data.question.locked) return;
      const index = Number(event.currentTarget.dataset.answerIndex);
      if (!utils.requiredAnswerIndices(this.data.question).includes(index)) return;
      const values = this.data.draftAnswers.slice();
      values[index] = String(event.detail.value || '');
      this.setData({ [`draftAnswers[${index}]`]: values[index] });
      this.triggerEvent('answerinput', { id: this.data.question.id, values, ...utils.answerProgress(this.data.question, values) });
    },
    toggleAnswer() { if (this.data.question && this.data.question.locked) return; this.setData({ answerVisible: !this.data.answerVisible }); },
    unlock() { this.triggerEvent('unlock', { id: this.data.question && this.data.question.id }); }
  }
});

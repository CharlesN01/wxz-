const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('../miniprogram/data/mock');

test('local literature mock has the eight prototype periods with six questions each', () => {
  const expectedCategories = [
    ['pre-qin', '先秦'], ['qin-han', '秦汉'], ['wei-jin', '六朝'], ['tang', '唐代'],
    ['song', '宋代'], ['yuan-ming-qing', '元明清'], ['modern', '现当代'], ['foreign', '外国文学']
  ];
  assert.deepEqual(mock.categories.map(({ id, name }) => [id, name]), expectedCategories);
  const categoryNames = new Map(expectedCategories);

  for (const [categoryId] of expectedCategories) {
    const questions = mock.questions.filter((item) => item.source === 'literature' && item.categoryId === categoryId);
    assert.equal(questions.length, 6, `${categoryId} should contain six prototype questions`);
    assert.ok(questions.every((item) => item.categoryName === categoryNames.get(categoryId)), `${categoryId} questions should expose their prototype category label`);
    assert.ok(questions.every((item) => item.type === 'fact' && item.answers.length > 0));
    assert.ok(questions.every((item) => (item.stem.match(/\{\{\d+\}\}/g) || []).length === item.answers.length));
  }
});

test('local classical directory follows the 25 prototype entries in order', () => {
  assert.deepEqual(mock.articles.map((item) => item.title), [
    '寡人之于国也', '劝学', '师说', '谏太宗十思疏', '鸿门宴', '廉颇蔺相如列传', '陈情表',
    '兰亭集序', '滕王阁序', '归去来兮辞', '春江花月夜', '蜀道难', '梦游天姥吟留别',
    '将进酒', '兵车行', '琵琶行', '阿房宫赋', '岳阳楼记', '醉翁亭记', '赤壁赋', '六国论',
    '指南录后序', '张中丞传后叙', '报任安书', '答司马谏议书'
  ]);
  assert.equal(mock.articles.length, 25);
  assert.deepEqual(mock.articles.map((item) => item.index), Array.from({ length: 25 }, (_value, index) => index + 1));
});

test('local mock includes all six original 劝学 word and translation exercises', () => {
  const words = mock.questions.filter((item) => item.articleId === 'quanxue' && item.type === 'word');
  assert.equal(words.length, 6);
  assert.ok(words.every((item) => item.articleTitle === '劝学'));
  assert.deepEqual(words.map(({ stem, answers }) => [stem, answers]), [
    ['“輮以为轮”中，“輮”的意思是{{0}}。', ['使弯曲']],
    ['“君子博学而日参省乎己”中，“日”的意思是{{0}}。', ['每天']],
    ['“积善成德，而神明自得”中，“得”的意思是{{0}}。', ['获得']],
    ['“假舟楫者，非能水也”中，“水”的意思是{{0}}。', ['游泳']],
    ['“而绝江河”中，“绝”的意思是{{0}}。', ['横渡']],
    ['“用心一也”中，“一”的意思是{{0}}。', ['专一']]
  ]);

  const translations = mock.questions.filter((item) => item.articleId === 'quanxue' && item.type === 'translation');
  assert.equal(translations.length, 6);
  assert.ok(translations.every((item) => item.articleTitle === '劝学'));
  assert.deepEqual(translations.map(({ stem, answers }) => [stem, answers[0]]), [
    ['“青，取之于蓝，而青于蓝。”翻译为{{0}}。', '靛青是从蓝草中提取的，但颜色比蓝草更深。'],
    ['“积善成德，而神明自得，圣心备焉。”翻译为{{0}}。', '积累善行形成良好的品德，就会获得非凡的智慧，具备圣人的思想境界。'],
    ['“君子生非异也，善假于物也。”翻译为{{0}}。', '君子的天性和普通人没有不同，只是善于借助外物罢了。'],
    ['“故木受绳则直，金就砺则利。”翻译为{{0}}。', '所以木材经过墨线比量就会变直，金属刀具靠近磨刀石磨过就会锋利。'],
    ['“吾尝跂而望矣，不如登高之博见也。”翻译为{{0}}。', '我曾经踮起脚向远处眺望，却不如登到高处看得广阔。'],
    ['“锲而舍之，朽木不折；锲而不舍，金石可镂。”翻译为{{0}}。', '雕刻几下便停下来，腐朽的木头也刻不断；不停地雕刻，金石也能雕刻成功。']
  ]);
});

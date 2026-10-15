// 仅为原型中的可辨识内容提供演示。正式题库可通过相同结构替换。
const config = {
  examDate: '2027-03-28', // 示例日期，不代表官方考试安排。
  dailyTarget: 20
};

const categories = [
  { id: 'pre-qin', name: '先秦' },
  { id: 'qin-han', name: '秦汉' },
  { id: 'wei-jin', name: '六朝' },
  { id: 'tang', name: '唐代' },
  { id: 'song', name: '宋代' },
  { id: 'yuan-ming-qing', name: '元明清' },
  { id: 'modern', name: '现当代' },
  { id: 'foreign', name: '外国文学' }
];

const articleRows = [
  ['guaren', '寡人之于国也'], ['quanxue', '劝学'], ['shishuo', '师说'],
  ['jiantaizong', '谏太宗十思疏'], ['hongmenyan', '鸿门宴'], ['lianpo', '廉颇蔺相如列传'],
  ['chenqing', '陈情表'], ['lanting', '兰亭集序'], ['tengwang', '滕王阁序'],
  ['guiqulaixi', '归去来兮辞'], ['chunjianghuayueye', '春江花月夜'], ['shudao', '蜀道难'],
  ['mengyou', '梦游天姥吟留别'], ['jiangjinjiu', '将进酒'], ['bingchexing', '兵车行'],
  ['pipaxing', '琵琶行'], ['afanggong', '阿房宫赋'], ['yueyang', '岳阳楼记'],
  ['zuiweng', '醉翁亭记'], ['chibifu', '赤壁赋'], ['liuguo', '六国论'],
  ['zhinanzhi', '指南录后序'], ['zhangzhongcheng', '张中丞传后叙'],
  ['baorenan', '报任安书'], ['sima', '答司马谏议书']
];
const articles = articleRows.map((row, index) => ({
  id: row[0], title: row[1], index: index + 1, placeholder: Boolean(row[2])
}));

const literatureRows = [
  ['pre-qin', '《诗经》是我国第一部____诗歌总集，收录诗歌____篇，又称《诗三百》。', ['诗歌', '305']],
  ['pre-qin', '《诗经》的体例分为____、____、____，表现手法为赋、比、兴，合称“六义”。', ['风', '雅', '颂']],
  ['pre-qin', '孔子是春秋时期____国人，____学派创始人，思想核心是____。', ['鲁', '儒家', '仁']],
  ['pre-qin', '《楚辞》开创了我国诗歌的____主义传统，代表作家是屈原。', ['浪漫']],
  ['pre-qin', '屈原是中国文学史上第一位伟大的____主义爱国诗人，代表作是《离骚》。', ['浪漫']],
  ['pre-qin', '《左传》是我国第一部叙事详细的____体史书。', ['编年']],
  ['qin-han', '《史记》是我国第一部____体通史，作者是西汉史学家____。', ['纪传', '司马迁']],
  ['qin-han', '汉乐府民歌《孔雀东南飞》与《木兰诗》合称“____”。', ['乐府双璧']],
  ['qin-han', '《汉书》是我国第一部____体断代史，作者是班固。', ['纪传']],
  ['qin-han', '汉赋代表作家有司马相如、扬雄、班固和____。', ['张衡']],
  ['qin-han', '《古诗十九首》是东汉末年一批____诗歌的选辑。', ['文人五言']],
  ['qin-han', '贾谊的代表政论文《过秦论》总结了____灭亡的历史教训。', ['秦朝']],
  ['wei-jin', '建安文学的代表作家是“三曹”和“____”。', ['建安七子']],
  ['wei-jin', '陶渊明是东晋著名诗人，开创了田园诗派，代表作有《归园田居》和____。', ['《饮酒》']],
  ['wei-jin', '《世说新语》是我国第一部____小说集，作者是刘义庆。', ['笔记']],
  ['wei-jin', '南北朝民歌中，北朝民歌代表作是____。', ['《木兰诗》']],
  ['wei-jin', '谢灵运是山水诗派的开创者，后世称其诗风为____。', ['山水诗']],
  ['wei-jin', '刘勰的《文心雕龙》是我国古代重要的文学____著作。', ['理论']],
  ['tang', '唐代诗人中，被称为“诗仙”的是____，被称为“诗圣”的是____。', ['李白', '杜甫']],
  ['tang', '白居易的长篇叙事诗《长恨歌》和____并称“姊妹篇”。', ['《琵琶行》']],
  ['tang', '王维、孟浩然是盛唐____诗派的代表诗人。', ['山水田园']],
  ['tang', '唐宋八大家中，唐代作家有韩愈和____。', ['柳宗元']],
  ['tang', '“初唐四杰”是王勃、杨炯、卢照邻和____。', ['骆宾王']],
  ['tang', '杜牧与李商隐并称“____”。', ['小李杜']],
  ['song', '北宋词人苏轼开创了____词派，扩大了词的表现范围。', ['豪放']],
  ['song', '李清照是宋代____派词人的代表，号易安居士。', ['婉约']],
  ['song', '“唐宋八大家”中宋代的六位作家不包括____。', ['苏轼以外的唐代作家']],
  ['song', '陆游是南宋著名爱国诗人，现存诗歌近____首。', ['万']],
  ['song', '《资治通鉴》是北宋司马光主持编纂的____体通史。', ['编年']],
  ['song', '辛弃疾是南宋____派词人，号稼轩。', ['豪放']],
  ['yuan-ming-qing', '元代散曲作家马致远的代表作是《天净沙·秋思》，被誉为“____”。', ['秋思之祖']],
  ['yuan-ming-qing', '关汉卿、马致远、郑光祖、白朴合称“____”。', ['元曲四大家']],
  ['yuan-ming-qing', '《三国演义》是我国第一部长篇____体历史小说。', ['章回']],
  ['yuan-ming-qing', '《红楼梦》的作者是____，一般认为后四十回由高鹗续写。', ['曹雪芹']],
  ['yuan-ming-qing', '蒲松龄的文言短篇小说集是____。', ['《聊斋志异》']],
  ['yuan-ming-qing', '吴敬梓的《儒林外史》是我国古代优秀的长篇____小说。', ['讽刺']],
  ['modern', '鲁迅的第一篇白话小说是____，收录于《呐喊》。', ['《狂人日记》']],
  ['modern', '郭沫若的诗集《女神》开创了中国现代____诗歌。', ['浪漫主义']],
  ['modern', '老舍的长篇小说《骆驼祥子》以____为主人公。', ['祥子']],
  ['modern', '巴金的“激流三部曲”包括《家》《春》和____。', ['《秋》']],
  ['modern', '朱自清散文《背影》以____为线索抒发父子深情。', ['背影']],
  ['modern', '曹禺的代表话剧《雷雨》塑造了____一家两代人的悲剧。', ['周朴园']],
  ['foreign', '古希腊两部史诗《伊利亚特》和____相传为荷马所作。', ['《奥德赛》']],
  ['foreign', '莎士比亚四大悲剧包括《哈姆雷特》《奥赛罗》《李尔王》和____。', ['《麦克白》']],
  ['foreign', '《堂吉诃德》的作者是西班牙作家____。', ['塞万提斯']],
  ['foreign', '雨果是法国浪漫主义作家，代表作有《巴黎圣母院》和____。', ['《悲惨世界》']],
  ['foreign', '泰戈尔是亚洲第一位获得____文学奖的作家。', ['诺贝尔']],
  ['foreign', '《老人与海》的作者是美国作家____。', ['海明威']]
];

const legacyLiteratureIds = {
  'pre-qin-1': 'lit-shijing-collection',
  'pre-qin-2': 'lit-shijing-six',
  'pre-qin-3': 'lit-confucius',
  'pre-qin-5': 'lit-quyuan'
};
const literatureCategoryNames = categories.reduce((names, category) => {
  names[category.id] = category.name;
  return names;
}, {});
const literatureIndexes = {};
const literatureQuestions = literatureRows.map((row) => {
  const categoryId = row[0];
  literatureIndexes[categoryId] = (literatureIndexes[categoryId] || 0) + 1;
  const index = literatureIndexes[categoryId];
  let blankIndex = 0;
  const stem = row[1].replace(/____/g, () => `{{${blankIndex++}}}`);
  return {
    id: legacyLiteratureIds[`${categoryId}-${index}`] || `lit-${categoryId}-${index}`,
    source: 'literature', categoryId, categoryName: literatureCategoryNames[categoryId] || '文学常识', type: 'fact', tag: '文学常识', stem,
    answers: row[2].slice()
  };
});

const wordQuestions = [
  { id: 'word-rou', stem: '“輮以为轮”中，“輮”的意思是{{0}}。', answers: ['使弯曲'] },
  { id: 'word-ri', stem: '“君子博学而日参省乎己”中，“日”的意思是{{0}}。', answers: ['每天'] },
  { id: 'word-de', stem: '“积善成德，而神明自得”中，“得”的意思是{{0}}。', answers: ['获得'] },
  { id: 'word-shui', stem: '“假舟楫者，非能水也”中，“水”的意思是{{0}}。', answers: ['游泳'] },
  { id: 'word-jue', stem: '“而绝江河”中，“绝”的意思是{{0}}。', answers: ['横渡'] },
  { id: 'word-yi', stem: '“用心一也”中，“一”的意思是{{0}}。', answers: ['专一'] }
].map((question) => ({
  ...question, source: 'classical', articleId: 'quanxue', articleTitle: '劝学', type: 'word', tag: '重点字词'
}));

const translationQuestions = [
  ['translation-qing', '青，取之于蓝，而青于蓝。', '靛青是从蓝草中提取的，但颜色比蓝草更深。'],
  ['translation-jishan', '积善成德，而神明自得，圣心备焉。', '积累善行形成良好的品德，就会获得非凡的智慧，具备圣人的思想境界。'],
  ['translation-junzi', '君子生非异也，善假于物也。', '君子的天性和普通人没有不同，只是善于借助外物罢了。'],
  ['translation-mushou', '故木受绳则直，金就砺则利。', '所以木材经过墨线比量就会变直，金属刀具靠近磨刀石磨过就会锋利。'],
  ['translation-qishi', '吾尝跂而望矣，不如登高之博见也。', '我曾经踮起脚向远处眺望，却不如登到高处看得广阔。'],
  ['translation-qie', '锲而舍之，朽木不折；锲而不舍，金石可镂。', '雕刻几下便停下来，腐朽的木头也刻不断；不停地雕刻，金石也能雕刻成功。']
].map((row) => ({
  id: row[0], source: 'classical', articleId: 'quanxue', articleTitle: '劝学', type: 'translation', tag: '句子翻译',
  stem: `“${row[1]}”翻译为{{0}}。`, answers: [row[2]]
}));

const questions = literatureQuestions.concat(wordQuestions, translationQuestions, [
  { id: 'classical-shishuo-author', source: 'classical', articleId: 'shishuo', type: 'fact', tag: '文言文', stem: '《师说》的作者是{{0}}。', answers: ['韩愈'] }
]);

module.exports = { config, categories, articles, questions };

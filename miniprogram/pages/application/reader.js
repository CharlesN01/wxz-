const sectionNames = {
  '写作样例': 'sample', '范文示例': 'sample', '格式框架': 'sample',
  '写作要点': 'points', '写作注意事项': 'points',
  '题目要求': 'requirement', '练习题目': 'requirement'
};

function genreOf(item) {
  return item.genreId ? { id: `genre:${item.genreId}`, name: item.genreName || '未命名文种' }
    : { id: `category:${item.categoryId || 'uncategorized'}`, name: item.categoryName || '其他文种' };
}

function genresFrom(items) {
  const entries = new Map();
  items.forEach((item) => {
    const genre = genreOf(item);
    if (!entries.has(genre.id)) entries.set(genre.id, genre);
  });
  return Array.from(entries.values());
}

function readingContent(item) {
  const body = String(item.body || '').replace(/\r\n?/g, '\n');
  const sections = { sample: [], points: [], requirement: [] };
  let current = 'sample';
  let marked = false;
  body.split('\n').forEach((line) => {
    const heading = line.trim().match(/^(?:#{1,4}\s*)?[【\[]?(写作样例|范文示例|格式框架|写作要点|写作注意事项|题目要求|练习题目)[】\]]?\s*(?:[：:]\s*(.*))?$/);
    if (heading) {
      current = sectionNames[heading[1]];
      marked = true;
      if (heading[2]) sections[current].push(heading[2]);
    } else sections[current].push(line);
  });
  let sample = sections.sample.join('\n').trim();
  let pointsText = sections.points.join('\n').trim();
  let requirement = sections.requirement.join('\n').trim();
  if (!marked && /写作要点|写作注意事项/.test(item.title || '')) {
    pointsText = body.trim();
    sample = '';
  }
  if (item.kind === 'exercise') {
    requirement = requirement || body.trim();
    sample = String(item.referenceAnswer || '').trim();
  }
  return {
    sample, requirement,
    points: pointsText.split('\n').map((line) => line.trim()).filter(Boolean),
    original: body,
    sourceLabel: ({ template: '写作模板', example: '范文示例', past_exam: '历年真题', exercise: '专项练习' })[item.kind] || '应用文内容'
  };
}

module.exports = { genreOf, genresFrom, readingContent };

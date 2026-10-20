function seconds(value) { return Math.max(0, Number(value) || 0); }
function minutes(value) { return Math.round(seconds(value) / 6) / 10; }

function learningTrend(statistics) {
  const source = statistics || {};
  const days = Array.isArray(source.dailyTrend) ? source.dailyTrend.slice(-7) : [];
  const total = days.reduce((sum, day) => sum + seconds(day.studySeconds), 0);
  const maximum = Math.max(1, ...days.map((day) => seconds(day.studySeconds)));
  const previous = seconds(source.previousPeriodStudySeconds);
  let hint = '近 7 天暂无学习时长';
  if (previous > 0) {
    const change = Math.round((total - previous) / previous * 100);
    hint = change === 0 ? '与前 7 天持平' : '较前 7 天 ' + (change > 0 ? '+' : '') + change + '%';
  } else if (total > 0) hint = '近 7 天共 ' + minutes(total) + ' 分钟';
  return {
    trendBars: days.map((day) => ({
      date: day.date,
      label: String(day.date || '').slice(5).replace('-', '/'),
      height: seconds(day.studySeconds) / maximum * 32,
      minutes: minutes(day.studySeconds), active: Boolean(day.isToday)
    })),
    trendHint: hint,
    trendHasData: total > 0
  };
}

module.exports = { learningTrend, minutes };

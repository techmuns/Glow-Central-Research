// A projection of the source's published cohort statistics, never a mean of
// whichever schemes happen to survive the reader's filters or display folding.
export function publishedCohorts(rows, periods) {
  const groups = new Map();
  for (const row of rows) {
    // Without a source cohort identity, do not guess which schemes are peers.
    if (!row.cohortKey) continue;
    if (!groups.has(row.cohortKey)) groups.set(row.cohortKey, []);
    groups.get(row.cohortKey).push(row);
  }
  return [...groups].map(([key, members]) => {
    const labels = [...new Set(members.map(r => r.classification || 'Unclassified'))];
    const plans = [...new Set(members.map(r => r.plan))];
    const options = [...new Set(members.map(r => r.option))];
    const stats = {};
    for (const period of periods) {
      const cells = members.map(r => r.returns?.[period]).filter(Boolean);
      const read = field => {
        const values = [...new Set(cells.map(c => c[field]).filter(Number.isFinite))];
        return {value:values.length === 1 ? values[0] : null, conflict:values.length > 1};
      };
      const average=read('categoryAverage'), median=read('categoryMedian'), peers=read('peerCount');
      stats[period]={average:average.value, median:median.value, peers:peers.value, conflict:average.conflict||median.conflict||peers.conflict};
    }
    return {key, name:labels.join(' / '), plan:plans.join(' / '), option:options.join(' / '), stats};
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key));
}

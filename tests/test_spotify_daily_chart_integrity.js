const assert=require('assert');
const fs=require('fs');

const dashboard=fs.readFileSync('spotify/dashboard.js','utf8');
const css=fs.readFileSync('spotify/dashboard.css','utf8');

for(const required of [
  'function buildStreamReportingGaps(histories)',
  'const STREAM_REPORTING_GAPS=buildStreamReportingGaps(HIST);',
  'STREAM_REPORTING_GAPS.has(previous[0]) || STREAM_REPORTING_GAPS.has(current[0])',
  'Jours Soundcharts incomplets masqués sur la courbe, sans répartition artificielle du rattrapage.',
  'class="spark-hover-point" style="display:none;background:${col}"'
]) assert.ok(dashboard.includes(required),`Missing daily-chart integrity guard: ${required}`);

assert.match(css,/\.spark\{display:block;cursor:default\}/,'the chart must keep the normal cursor');
assert.match(css,/\.spark-hover-point\{[^}]*border-radius:50%/,'the hover marker must be a true circle');
assert.ok(!css.includes('cursor:crosshair'),'the crosshair cursor must not remain on the stream chart');

console.log('spotify daily chart integrity: ok');

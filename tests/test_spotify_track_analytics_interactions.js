'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');

assert.match(dashboard, /function bindSparklineHover\(root\)/,
  'Daily analytics charts must bind their own hover interaction.');
assert.match(dashboard, /addEventListener\('pointermove',event=>showNearestSparkPoint\(svg,event\)\)/,
  'Hovering any point along a chart must select the nearest daily data point.');
assert.match(dashboard, /marker=wrap\.querySelector\('\.spark-hover-point'\)/,
  'The visible hover marker must be looked up in the chart wrapper, beside the SVG.');
assert.doesNotMatch(dashboard, /marker=svg\.querySelector\('\.spark-hover-point'\)/,
  'The hover marker is not an SVG child and must never be looked up there.');
assert.match(dashboard, /bindSparklineHover\(box\);/,
  'Track, artist, and playlist analytics panels must activate the hover marker.');
const opportunityStart = dashboard.indexOf('function openArOpportunity(spotifyId){');
const opportunityEnd = dashboard.indexOf('\nfunction sortTriangleIndicator', opportunityStart);
const opportunityPanel = dashboard.slice(opportunityStart, opportunityEnd);
assert.ok(opportunityStart >= 0 && opportunityEnd > opportunityStart,
  'The Opportunity analytics panel must be independently testable.');
assert.match(opportunityPanel, /trackDailyAnalyticsHtml\(spotifyId,'ar'\)/,
  'Opportunity details must render the shared daily track chart.');
assert.match(opportunityPanel, /bindSparklineHover\(box\);/,
  'Opportunity details must activate the nearest-point hover interaction.');
for (const required of [
  'class="spark-y-axis"',
  'class="spark-x-axis"',
  'class="spark-grid"',
  'class="spark-line"',
  'vector-effect="non-scaling-stroke"',
  'stroke-linecap="round"',
  'stroke-linejoin="round"',
  'function sparklineAxisValueLabel(value,unit)',
  'function sparklineAxisDateLabel(value)',
]) assert.ok(dashboard.includes(required), `Missing shared chart rendering token: ${required}`);
for (const required of ['.spark-chart', '.spark-plot', '.spark-y-axis', '.spark-x-axis', '.spark-hover-guide']) {
  assert.ok(css.includes(required), `Missing responsive chart style: ${required}`);
}
assert.match(dashboard, /dailyChartHtml\(audience\.history,[^\n]+,'listeners'\)/,
  'Monthly-listener charts must expose their real unit.');
assert.match(dashboard, /dailyChartHtml\(hist,[^\n]+,'followers'\)/,
  'Playlist charts must expose their real unit.');
assert.match(dashboard, /const yLabels=y1===y0\?\['',yMaxLabel,''\]:\[yMaxLabel,sparklineAxisValueLabel\(yMiddle,unit\),yMinLabel\]/,
  'Visible ordinate labels must come from the observed maximum, midpoint, and minimum without duplicating flat values.');
assert.match(dashboard, /const xLabels=\[pts\[0\]\[0\],pts\[middleIndex\]\[0\],pts\[pts\.length-1\]\[0\]\]/,
  'Visible abscissa labels must come from observed dates only.');

const chartStart = dashboard.indexOf('function sparklineValueLabel(value,unit){');
const chartEnd = dashboard.indexOf('\n/* mini simulateur', chartStart);
const chartContext = {
  revenueEstimate: value => `$${value}`,
  fmtFull: value => String(value),
  fmt: value => String(value),
  fmtDate: value => String(value),
  esc: value => String(value),
};
vm.createContext(chartContext);
vm.runInContext(dashboard.slice(chartStart, chartEnd), chartContext);
const chart = chartContext.sparkline([
  ['2026-07-20', 120],
  ['2026-07-21', 410],
  ['2026-07-22', 245],
], 'streams');
assert.match(chart, /<div class="spark-y-axis"[^>]*><span>410<\/span><span>265<\/span><span>120<\/span>/,
  'The visible Y axis must use the real maximum, midpoint, and minimum.');
assert.match(chart, /<div class="spark-x-axis"[^>]*><span>2026-07-20<\/span><span>2026-07-21<\/span><span>2026-07-22<\/span>/,
  'The visible X axis must use the first, middle, and last observed dates.');
assert.equal((chart.match(/class="spark-point"/g) || []).length, 3,
  'The renderer must expose exactly one hover point per real observation.');
const linePath = chart.match(/<path class="spark-line" d="([^"]+)"/)[1];
assert.doesNotMatch(linePath, /[CQ]/,
  'The chart must connect observed points directly and never invent smoothed values.');
const flatChart = chartContext.sparkline([['2026-07-20',200],['2026-07-21',200]],'streams');
assert.equal((flatChart.match(/<span>200<\/span>/g) || []).length,1,
  'A flat series must show its single observed ordinate once instead of three duplicate labels.');
assert.doesNotMatch(flatChart,/NaN|Infinity/,'A flat series must keep finite chart coordinates and labels.');
const decliningChart = chartContext.sparkline([
  ['2026-07-20', 410],
  ['2026-07-21', 245],
  ['2026-07-22', 120],
], 'streams');
assert.match(decliningChart, /class="spark-area"[^>]+fill="#4ade80"/,
  'A declining analytics series must keep the shared Spotify green area.');
assert.match(decliningChart, /class="spark-line"[^>]+stroke="#4ade80"/,
  'A declining analytics series must keep the shared Spotify green line.');
assert.equal((decliningChart.match(/class="spark-point"[^>]+fill="#4ade80"/g) || []).length, 3,
  'Every observed analytics point must use the shared Spotify green.');
assert.match(decliningChart, /class="spark-hover-point" style="display:none;background:#4ade80"/,
  'The nearest-point hover marker must use the shared Spotify green.');
assert.doesNotMatch(decliningChart, /#fb7185/,
  'A negative final delta must never turn an analytics chart red.');
assert.doesNotMatch(dashboard.slice(chartStart, chartEnd), /ys\[ys\.length-1\]\s*>?=\s*ys\[0\]/,
  'Chart colour must not depend on the first-to-last delta.');

const marker = {style:{}};
const guide = {style:{}};
const tip = {style:{},textContent:''};
const classes = {added:false,add(){this.added=true;},remove(){this.added=false;}};
const wrap = {querySelector: selector => ({'.spark-tooltip':tip,'.spark-hover-point':marker,'.spark-hover-guide':guide}[selector]),classList:classes};
const dots = [40,280,520].map((cx,index)=>({
  dataset:{date:`d${index}`,value:`v${index}`},
  getAttribute:name=>name==='cx'?String(cx):'60',
}));
const fakeSvg = {
  closest:()=>wrap,
  querySelectorAll:()=>dots,
  getBoundingClientRect:()=>({left:0,width:280,height:60}),
};
chartContext.showNearestSparkPoint(fakeSvg,{clientX:180});
assert.equal(tip.textContent,'d1 · v1','Hover must select the nearest real observation at responsive widths.');
assert.equal(marker.style.left,'140px','The hover point must stay aligned with the responsive plot.');
assert.equal(guide.style.left,'140px','The hover guide must stay aligned with the selected point.');
chartContext.hideNearestSparkPoint(fakeSvg);
assert.equal(marker.style.display,'none','Leaving the plot must hide the hover point.');
assert.match(dashboard, /function arRetryPlaylistCover\(image,playlistId\)/,
  'Editorial covers must retry through the resilient cover loader after an image error.');
assert.match(dashboard, /open\.spotify\.com\/oembed\?url=/,
  'Missing editorial covers must resolve from Spotify oEmbed.');
assert.doesNotMatch(dashboard, /data-metric-mode="streams" title=/,
  'Metric-mode buttons must not have a native hover tooltip.');
assert.doesNotMatch(dashboard, /class="num" title=/,
  'Numeric table cells must not have native hover tooltips.');
assert.doesNotMatch(dashboard, /data-ar-sort="\$\{value\}" class="\$\{active\?'on':''\} \$\{dir\}" title=/,
  'Opportunity sorting controls must not have a native hover tooltip.');

console.log('spotify track analytics interactions: OK');

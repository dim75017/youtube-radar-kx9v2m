'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardPath = path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js');
const source = fs.readFileSync(dashboardPath, 'utf8');
const helpersStart = source.indexOf('const ANA_AGE_COHORTS');
const rowsStart = source.indexOf('function anaRows(){', helpersStart);
const rowsEnd = source.indexOf('function fmtWatch', rowsStart);
assert.ok(helpersStart >= 0 && rowsStart > helpersStart && rowsEnd > rowsStart,
  'age-normalized Analysis helpers must remain defined');

const RealDate = Date;
const now = new RealDate('2026-07-23T12:00:00Z').getTime();
class FixedDate extends RealDate {
  static now() { return now; }
}
const daysAgo = days => now - days * 86_400_000;
const video = (vid, days, views) => ({vid, pub: daysAgo(days), views, genre: 'Ambient', durH: 1});
const latest = {
  vid: 'latest-lofi',
  title: 'summer lofi - chill beats to relax to',
  pub: daysAgo(2),
  views: 2_000,
  comments: 321,
};
const ours = [latest, video('young-a', 5, 1_000), video('young-b', 6, 800), video('young-c', 7, 600), video('old', 200, 100_000)];
ours.find(row => row.vid === 'young-b').comments = -1;
const history = Object.fromEntries(ours.map(row => [row.vid, [[now, row.views]]]));
const market = [video('market-young-a', 5, 1_100), video('market-young-b', 6, 900), video('market-young-c', 7, 700), video('market-old', 200, 999_999)];
const context = {
  Date: FixedDate,
  DATA: {ours, hist: history, recos: []},
  SYNCED: 1,
  window: {
    STUDIO_DATA: {d: {'latest-lofi': {awtMs: 1_308_000, awp: 35.74}}},
    CMT: {'latest-lofi': 999, 'young-a': 17, 'young-b': 19},
  },
  mixRows: () => market,
  genreKey: () => 'ambient',
  recoGenreKey: (value, row) => /\b(?:lofi|lo-fi|chillhop)\b/i.test(String(value || '') + ' ' + String(row?.title || '')) ? 'lofi' : '',
  videoThirtyDayMetric: (row) => ({value: null, kind: 'lifetime', label: 'lifetime avg/month', note: '30-day history partial'}),
  anaDiags: () => [],
  median(values) {
    const ordered = values.filter(value => value != null).sort((a, b) => a - b);
    if (!ordered.length) return null;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  },
};
vm.runInNewContext(
  `let _anaCache=null,_anaT=0; ${source.slice(helpersStart, rowsEnd)}; this.rows=anaRows; this.comparable=anaAgeComparable;`,
  context,
);

const rows = context.rows();
const young = rows.find(row => row.vid === 'young-a');
const old = rows.find(row => row.vid === 'old');
const enrichedLatest = rows.find(row => row.vid === 'latest-lofi');
assert.equal(enrichedLatest.genre, 'Lofi / chillhop', 'an explicit genre in the title must fill the missing badge');
assert.ok(Math.abs(enrichedLatest.durH - (1_308_000 / 0.3574 / 3_600_000)) < 1e-9,
  'Studio watch duration and watched percentage must restore the real video duration');
assert.equal(enrichedLatest.comments, 321, 'fresh row comments must override the legacy CMT snapshot');
assert.equal(young.comments, 17, 'legacy CMT remains a fallback while old rows migrate');
assert.equal(rows.find(row => row.vid === 'young-b').comments, 19,
  'invalid direct comments must fall back instead of being coerced to zero');
assert.equal(young.cohAgeLabel, '0-7 days');
assert.equal(young.cohN, 3, 'market comparison must exclude the older, high-view video');
assert.equal(young.medViews, 800, 'channel raw-view baseline must only use releases of the same age');
assert.equal(old.pctCh, null, 'insufficient same-age peers must remain neutral instead of falling back to all ages');
assert.ok(young.vpm > 0, 'lifetime velocity stays available as an age-normalized raw metric');
assert.match(source, /function anaProgressBarHTML\(o\)/,
  'Analysis cards must use one shared progress-bar renderer');
const pcolStart = source.indexOf('function pcol(');
const pcolEnd = source.indexOf('\nfunction vsMed', pcolStart);
const performanceStart = source.indexOf('function anaPercentileValue(');
const performanceEnd = source.indexOf('\nfunction anaCardHTML', performanceStart);
assert.ok(pcolStart >= 0 && pcolEnd > pcolStart && performanceStart >= 0 && performanceEnd > performanceStart,
  'Analysis percentile and progress helpers must remain independently testable');
const progressContext = {};
vm.runInNewContext(
  `${source.slice(pcolStart, pcolEnd)}\n${source.slice(performanceStart, performanceEnd)}; this.progress=anaProgressBarHTML;`,
  progressContext,
);
const pending = progressContext.progress({pctCh: null, pct: null});
assert.match(pending, /data-performance-source="pending"/,
  'missing comparisons must be labelled pending instead of becoming a fake zero percentile');
assert.match(pending, /width:50%;background:#64748b/,
  'missing comparisons must render a visible neutral midpoint bar');
assert.match(pending, />pending<\/span>/, 'the pending state must be explicit on the card');
assert.doesNotMatch(pending, /background:#f87171/,
  'missing comparisons must never inherit the underperformance red');
const marketFallback = progressContext.progress({pctCh: '', pct: 75});
assert.match(marketFallback, /data-performance-source="market"/,
  'a real age-matched market percentile may backfill a missing channel percentile');
assert.match(marketFallback, /width:75%;background:#34d399/,
  'the market fallback must preserve its factual percentile and color');
const invalid = progressContext.progress({pctCh: 'not-a-number', pct: null});
assert.match(invalid, /data-performance-source="pending"/,
  'non-numeric values must stay pending rather than being coerced to a score');
const realZero = progressContext.progress({pctCh: 0, pct: 75});
assert.match(realZero, /data-performance-source="channel"/,
  'a real zero percentile remains valid and must not fall through to market');
const cardStart = source.indexOf('function anaCardHTML(');
const cardEnd = source.indexOf('\nfunction fillAnaLikes', cardStart);
assert.ok(cardStart >= 0 && cardEnd > cardStart, 'Analysis card renderer must remain available');
assert.match(source.slice(cardStart, cardEnd), /gtag\(o\.genre\).*fmtDur\(o\.durH\)/,
  'Analysis grid cards must show genre and duration together');
assert.match(source.slice(cardStart, cardEnd), /const cmt=o\.comments/,
  'Analysis cards must render the normalized fresh-or-legacy comment count');
assert.doesNotMatch(source.slice(cardStart, cardEnd), /age cohort ·/,
  'The age-cohort label must not clutter Analysis cards');

const drawerStart = source.indexOf('function openAnaIdx(');
const drawerEnd = source.indexOf('/* ================= LIVESTREAMS', drawerStart);
assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, 'Analysis detail drawer must remain available');
assert.match(source.slice(drawerStart, drawerEnd), /gtag\(o\.genre\).*fmtDur\(o\.durH\)/,
  'Analysis detail must show the same genre and duration metadata');

console.log('YouTube age-normalized analysis: OK');

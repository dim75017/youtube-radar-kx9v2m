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
};
const ours = [latest, video('young-a', 5, 1_000), video('young-b', 6, 800), video('young-c', 7, 600), video('old', 200, 100_000)];
const history = Object.fromEntries(ours.map(row => [row.vid, [[now, row.views]]]));
const market = [video('market-young-a', 5, 1_100), video('market-young-b', 6, 900), video('market-young-c', 7, 700), video('market-old', 200, 999_999)];
const context = {
  Date: FixedDate,
  DATA: {ours, hist: history, recos: []},
  SYNCED: 1,
  window: {STUDIO_DATA: {d: {'latest-lofi': {awtMs: 1_308_000, awp: 35.74}}}, CMT: {}},
  mixRows: () => market,
  genreKey: () => 'ambient',
  recoGenreKey: (value, row) => /\b(?:lofi|lo-fi|chillhop)\b/i.test(String(value || '') + ' ' + String(row?.title || '')) ? 'lofi' : '',
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
assert.equal(young.cohAgeLabel, '0-7 days');
assert.equal(young.cohN, 3, 'market comparison must exclude the older, high-view video');
assert.equal(young.medViews, 800, 'channel raw-view baseline must only use releases of the same age');
assert.equal(old.pctCh, null, 'insufficient same-age peers must remain neutral instead of falling back to all ages');
assert.ok(young.vpm > 0, 'lifetime velocity stays available as an age-normalized raw metric');
assert.match(source, /function anaProgressBarHTML\(o\)/,
  'Analysis cards must use one shared progress-bar renderer');
assert.match(source, /hasPercentile\?Math\.max\(0,Math\.min\(100,Number\(o\.pctCh\)\)\):50/,
  'Missing comparable peers must render a neutral midpoint bar, not an invisible zero-width bar');
const cardStart = source.indexOf('function anaCardHTML(');
const cardEnd = source.indexOf('\nfunction fillAnaLikes', cardStart);
assert.ok(cardStart >= 0 && cardEnd > cardStart, 'Analysis card renderer must remain available');
assert.match(source.slice(cardStart, cardEnd), /gtag\(o\.genre\).*fmtDur\(o\.durH\)/,
  'Analysis grid cards must show genre and duration together');
assert.doesNotMatch(source.slice(cardStart, cardEnd), /age cohort ·/,
  'The age-cohort label must not clutter Analysis cards');

const drawerStart = source.indexOf('function openAnaIdx(');
const drawerEnd = source.indexOf('/* ================= LIVESTREAMS', drawerStart);
assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, 'Analysis detail drawer must remain available');
assert.match(source.slice(drawerStart, drawerEnd), /gtag\(o\.genre\).*fmtDur\(o\.durH\)/,
  'Analysis detail must show the same genre and duration metadata');

console.log('YouTube age-normalized analysis: OK');

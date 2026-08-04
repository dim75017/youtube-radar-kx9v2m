'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const RECOMMENDATION_SOURCE = path.join(ROOT, 'assets/js/dashboard-04-recommendations.js');
const DATA_FILE = path.join(ROOT, 'Lofi_Radar_data.js');
const POOL_FILE = path.join(ROOT, 'Lofi_Radar_recommendation_pool.js');
const STUDIO_FILE = path.join(ROOT, 'Lofi_Radar_studio.js');
const HISTORY_DIR = path.join(ROOT, 'video_history');

function readAssignedJson(file) {
  const source = fs.readFileSync(file, 'utf8').trim();
  const equals = source.indexOf('=');
  assert.ok(equals > 0, `${path.basename(file)} must remain a JavaScript JSON assignment`);
  return JSON.parse(source.slice(equals + 1).replace(/;\s*$/, ''));
}

function readHistoryShards() {
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0, 'the real video-history shards must be present');

  const history = {};
  for (const file of files) {
    const shard = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
    assert.ok(shard && shard.d && typeof shard.d === 'object', `${file} must expose a history map`);
    for (const [videoId, points] of Object.entries(shard.d)) {
      assert.equal(history[videoId], undefined, `history for ${videoId} must live in one shard only`);
      history[videoId] = points;
    }
  }
  return {history, files};
}

const AGE_COHORT_MAX_DAYS = [7, 30, 90, 180, 365, Infinity];

function cohortIndex(ageDays) {
  return AGE_COHORT_MAX_DAYS.findIndex(max => ageDays <= max);
}

function comparableRows(rows, ageDays, minimum) {
  const target = cohortIndex(ageDays);
  const exact = rows.filter(row => cohortIndex(row.ageDays) === target);
  if (exact.length >= minimum) return exact;
  const nearby = rows.filter(row => Math.abs(cohortIndex(row.ageDays) - target) <= 1);
  return nearby.length >= minimum ? nearby : [];
}

function buildOwnedAnalyticsRows(owned, history, studio, snapshotTime) {
  const dayMs = 86400000;
  const rows = owned
    .filter(row => row.pub && (row.durH == null || row.durH >= 0.15))
    .map(row => {
      const points = (history[row.vid] || []).slice().sort((a, b) => a[0] - b[0]);
      const ageDays = Math.max((snapshotTime - Number(row.pub)) / dayMs, 0);
      const views = points.length
        ? Number(points[points.length - 1][1])
        : (Number.isFinite(Number(row.views)) ? Number(row.views) : null);
      const vpm = Number.isFinite(views) && ageDays > 0 ? views / ageDays * 30.44 : null;
      let vNow = null;
      if (points.length >= 2) {
        const end = points[points.length - 1];
        const cutoff = end[0] - 30.44 * dayMs;
        const recent = points.filter(point => point[0] >= cutoff);
        const start = recent.length >= 2 ? recent[0] : points[points.length - 2];
        const elapsedDays = Math.max((end[0] - start[0]) / dayMs, 0.5);
        vNow = (Number(end[1]) - Number(start[1])) / elapsedDays * 30.44;
      }
      return Object.assign({}, row, {
        ageDays,
        ageM: ageDays / 30.44,
        views,
        vpm,
        vNow,
        st: studio.d[row.vid] || null,
      });
    });

  for (const row of rows) {
    const peers = comparableRows(rows.filter(peer => peer.vid !== row.vid), row.ageDays, 2);
    const lifetimePeers = peers.filter(peer => peer.vpm != null);
    const recentPeers = peers.filter(peer => peer.vNow != null);
    row.pctCh = row.vpm != null && lifetimePeers.length >= 2
      ? Math.round(lifetimePeers.filter(peer => peer.vpm < row.vpm).length / lifetimePeers.length * 100)
      : null;
    row.pctNow = row.vNow != null && recentPeers.length >= 2
      ? Math.round(recentPeers.filter(peer => peer.vNow < row.vNow).length / recentPeers.length * 100)
      : null;
  }
  return rows;
}

function personaCategory(value) {
  if (/synthwave boy/i.test(String(value || ''))) return 'Synthwave Boy';
  if (/lofi girl/i.test(String(value || ''))) return 'Lofi Girl';
  return 'Sans personnage';
}

function fixedDateClass(timestamp) {
  return class SnapshotDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [timestamp]));
    }

    static now() {
      return timestamp;
    }
  };
}

function recommendationContext({recos, ownedRows, measuredSeeds, snapshotTime}) {
  const source = fs.readFileSync(RECOMMENDATION_SOURCE, 'utf8');
  const start = source.indexOf('const GENERATED_RECO_DECISIONS_KEY=');
  const end = source.indexOf('function ensureRecommendationPerformanceHistory()', start);
  assert.ok(start >= 0 && end > start, 'recommendation learning helpers must remain available');

  const stored = new Map();
  const context = {
    DATA: {recos: recos.map(row => Object.assign({}, row))},
    LANG: 'fr',
    Date: fixedDateClass(snapshotTime),
    Intl,
    Set,
    Map,
    Object,
    Number,
    String,
    Math,
    JSON,
    Array,
    console,
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, value); },
    },
    window: {
      LOFI_RECOMMENDATION_POOL: {
        items: measuredSeeds.map(row => Object.assign({}, row)),
      },
    },
    normalizedRecommendationTitle(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    },
    persoCategory: personaCategory,
    isValidated(value) { return /^x(?=$|\s|[,;:\-])/i.test(String(value || '').trim()); },
    isRefused(value) { return /^-/.test(String(value || '').trim()); },
    recommendationRoadmapEntry() { return null; },
    scheduledRows() { return []; },
    anaRows() { return ownedRows.map(row => Object.assign({}, row)); },
    rerenderRecos() {},
  };

  vm.runInNewContext(`${source.slice(start, end)}
    this.profileForTest = recoProfile;
    this.scoreForTest = recoDailyScore;
    this.dailySetForTest = dailyRecommendationSet;
    this.minimumScoreForTest = RECO_MIN_DAILY_SCORE;`, context);
  return context;
}

const dataPayload = readAssignedJson(DATA_FILE);
const poolPayload = readAssignedJson(POOL_FILE);
const studioPayload = readAssignedJson(STUDIO_FILE);
const {history, files: historyFiles} = readHistoryShards();
const snapshotTime = Number(dataPayload.videoMetricsT || dataPayload.t || poolPayload.sourceT);
const owned = dataPayload.d.ours || [];
const generated = poolPayload.items || [];

assert.equal(poolPayload.schema, 3, 'the checked-in recommendation browser projection must use schema V3');
assert.equal(poolPayload.version, 3, 'the checked-in recommendation reservoir must use generator V3');
assert.equal(generated.length, 2500, 'the bounded real browser projection must contain 2,500 ideas');
assert.ok(poolPayload.ledger && Number(poolPayload.ledger.total) >= generated.length,
  'the append-only ledger must be larger than or equal to the bounded browser projection');
assert.match(String(poolPayload.buildId || ''), /^[a-f0-9]{24}$/,
  'the V3 projection must expose its deterministic build id');
assert.match(String(poolPayload.ledgerRevision || ''), /^[a-f0-9]{64}$/,
  'the V3 projection must expose its exact ledger revision');
assert.equal(owned.length, 50, 'the real owned-channel snapshot must still expose all 50 videos');
assert.ok(Number.isFinite(snapshotTime), 'the real snapshot must expose a stable measurement timestamp');
assert.ok(historyFiles.length >= 1, 'at least one real history shard must be loaded');

const allowedWindows = new Set(['0-3m', '3-6m', '6-12m']);
const allowedGenres = new Set([
  'lofi', 'ambient', 'nature', 'jazz', 'piano', 'classical', 'guitar', 'house', 'dnb', 'synthwave',
]);
for (const row of generated) {
  assert.equal(row._generated, true, `pool row ${row.n} must be identified as generated`);
  assert.ok(row._generatorVersion === 2 || row._generatorVersion === 3,
    `pool row ${row.n} must be a losslessly bootstrapped V2 item or a source-backed V3 item`);
  if (row._generatorVersion === 3) {
    assert.match(String(row._ideaKey || ''), /^g3\|r1\|/,
      `V3 pool row ${row.n} must expose its stable recipe key`);
    assert.equal(row._recipeVersion, 1, `V3 pool row ${row.n} must use recipe schema 1`);
    assert.ok(Number.isSafeInteger(Number(row.n)), `V3 pool row ${row.n} must use a JS-safe stable id`);
  }
  assert.equal(row._scoringVersion, 4, `pool row ${row.n} must use evidence-calibrated scoring V4`);
  assert.ok(Number.isFinite(Number(row._sourceAgeM)), `pool row ${row.n} must expose a measured source age`);
  assert.ok(Number(row._sourceAgeM) >= 0 && Number(row._sourceAgeM) <= 12,
    `pool row ${row.n} must only use a source observed within 12 months`);
  assert.ok(allowedWindows.has(row._sourceWindow), `pool row ${row.n} must use a canonical 3/6/12-month window`);
  assert.ok(allowedGenres.has(row._genreKey), `pool row ${row.n} must use a normalized canonical genre`);
  assert.equal(Object.prototype.hasOwnProperty.call(row, '_continuousVariant'), false,
    `pool row ${row.n} must not be a browser-fabricated continuous variant`);
}
assert.ok(generated.some(row => row._generatorVersion === 2),
  'the V3 projection must preserve the existing V2 recommendation identities');
assert.ok(generated.some(row => row._generatorVersion === 3),
  'the V3 projection must expose newly generated ledger-backed ideas');
assert.deepEqual(new Set(generated.map(row => row._sourceWindow)), allowedWindows,
  'the real mixed V2/V3 reservoir must cover 0-3m, 3-6m and 6-12m');
const generatedTiers = new Set(generated.map(row => String(row.pot || '')[0]));
assert.ok(generatedTiers.has('S'), 'the real measured reservoir must expose evidence-backed S ideas');
assert.ok(generatedTiers.has('A') && generatedTiers.has('B'),
  'the real measured reservoir must retain meaningful A and B grades');

const historyCoverage = owned.filter(row => Array.isArray(history[row.vid]) && history[row.vid].length > 0);
const multiPointCoverage = owned.filter(row => Array.isArray(history[row.vid]) && history[row.vid].length >= 2);
const studioCoverage = owned.filter(row => studioPayload.d && studioPayload.d[row.vid]);
assert.equal(historyCoverage.length, owned.length, 'all 50 owned videos must be connected to real history shards');
assert.ok(multiPointCoverage.length >= 20, 'enough owned videos must have multi-day history for recent velocity');
assert.ok(studioCoverage.length >= 20, 'enough owned videos must be connected to real YouTube Studio metrics');

const analyticsEligibleOwned = owned.filter(
  row => row.pub && (row.durH == null || row.durH >= 0.15),
);
const analyticsEligibleStudioCoverage = analyticsEligibleOwned.filter(
  row => studioPayload.d && studioPayload.d[row.vid],
);
const ownedRows = buildOwnedAnalyticsRows(owned, history, studioPayload, snapshotTime);
assert.equal(
  ownedRows.length,
  analyticsEligibleOwned.length,
  'the simulated anaRows input must contain every duration-eligible owned video',
);
assert.ok(ownedRows.length >= 20, 'the real snapshot must keep enough eligible owned videos for learning');
assert.equal(ownedRows.filter(row => row.st).length, analyticsEligibleStudioCoverage.length,
  'the simulated anaRows input must preserve the real Studio coverage');
assert.ok(ownedRows.filter(row => row.vNow != null).length >= 20,
  'the simulated anaRows input must expose recent velocity from history shards');

const context = recommendationContext({
  recos: (dataPayload.d.recos || []).concat(generated),
  ownedRows,
  measuredSeeds: generated,
  snapshotTime,
});
const profile = context.profileForTest();

assert.ok(profile.windows['3m'] > 0, 'the real channel profile must contain a 0-3m performance window');
assert.ok(profile.windows['6m'] > 0, 'the real channel profile must contain a 3-6m performance window');
assert.ok(profile.windows['12m'] > 0, 'the real channel profile must contain a 6-12m performance window');
for (const genre of ['lofi', 'synthwave', 'nature']) {
  const signal = Number(profile.performanceGenre[genre]);
  assert.ok(Number.isFinite(signal) && signal !== 0,
    `the real owned-video snapshot must produce a non-empty ${genre} performance signal`);
}

const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(snapshotTime));
const qualified = generated
  .map(row => ({row, score: Number(context.scoreForTest(row, profile, day))}))
  .filter(item => Number.isFinite(item.score) && item.score >= context.minimumScoreForTest)
  .sort((a, b) => b.score - a.score || Number(a.row.n) - Number(b.row.n));
assert.ok(qualified.length >= 20,
  'the real V2 reservoir and real channel analytics must yield at least 20 quality-qualified ideas');
assert.ok(qualified.every((item, index) => index === 0 || qualified[index - 1].score >= item.score),
  'the quality-qualified real reservoir must be rankable by the daily score');
const realDailyBatch = Array.from(context.dailySetForTest());
assert.equal(realDailyBatch.length, 50,
  'the real measured reservoir must supply the complete daily 50-card promise');
const objectiveRowsById = new Map((dataPayload.d.recos || []).concat(generated).map(row => [Number(row.n), row]));
assert.ok(realDailyBatch.every(row => {
  const objective = objectiveRowsById.get(Number(row.n)) || {};
  const score = Number(objective.score != null ? objective.score : objective.scoreAdj);
  const calibrated = Number(objective._scoringVersion) >= 4 && Number.isFinite(score);
  const visibleScore = calibrated ? Math.round(score) : Math.round(Number(row._dailyScore));
  const expected = visibleScore >= 95 ? 'S' : visibleScore >= 88 ? 'A' : visibleScore >= 78 ? 'B' : 'C';
  return String(row.pot || '')[0] === expected
    && Number(row.scoreAdj) === visibleScore
    && Number.isFinite(Number(row._dailyScore));
}), 'V4 grades preserve objective evidence while legacy grades stay aligned with adaptive daily evidence');

console.log(`YouTube recommendation real snapshot: OK (${qualified.length} qualified, ${historyFiles.length} history shards, ${analyticsEligibleStudioCoverage.length}/${analyticsEligibleOwned.length} eligible Studio)`);

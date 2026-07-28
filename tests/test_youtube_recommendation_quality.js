'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf("const GENERATED_RECO_DECISIONS_KEY=");
const end = source.indexOf('function ensureRecommendationPerformanceHistory()', start);
assert.ok(start >= 0 && end > start, 'recommendation learning helpers must remain available');

function personaCategory(value) {
  if (/synthwave boy/i.test(String(value || ''))) return 'Synthwave Boy';
  if (/lofi girl/i.test(String(value || ''))) return 'Lofi Girl';
  return 'Sans personnage';
}

function makeContext({recos = [], owned = [], measuredSeeds = [], stored = new Map()} = {}) {
  const context = {
    DATA: {recos: recos.map(row => Object.assign({}, row))},
    LANG: 'fr',
    Date,
    Intl,
    Set,
    Map,
    Object,
    Number,
    String,
    Math,
    JSON,
    Array,
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
    anaRows() { return owned.map(row => Object.assign({}, row)); },
    rerenderRecos() {},
  };

  vm.runInNewContext(`${source.slice(start, end)}
    this.profileForTest = recoProfile;
    this.scoreForTest = recoDailyScore;
    this.dailySetForTest = dailyRecommendationSet;
    this.generateVariantsForTest = generateContinuousRecommendationVariants;`, context);
  return context;
}

function scoreFor(context, row, profile) {
  return context.scoreForTest(row, profile, '2026-07-28');
}

// Real owned-channel rows do not currently carry a genre. The recommendation
// learner must infer the obvious title signal and match it to the canonical
// genre behind the emoji-bearing display label.
const lofiCandidate = {
  n: 101,
  valid: '',
  score: 78,
  genre: '🎧 Lofi',
  perso: 'Lofi Girl',
  title: 'Quiet Library',
  concept: 'A focused evening format.',
};
const ambientCandidate = {
  n: 102,
  valid: '',
  score: 80,
  genre: '🌌 Ambient',
  perso: 'Lofi Girl',
  title: 'Silent Observatory',
  concept: 'A slow nocturnal format.',
};
const ownedSummerLofi = {
  vid: 'ownedLofi01',
  ageM: 1,
  pctNow: 96,
  pctCh: 55,
  genre: '',
  perso: '',
  title: 'summer lofi',
  st: {ctr: 6.4, awp: 48},
};
const performanceContext = makeContext({
  recos: [lofiCandidate, ambientCandidate],
  owned: [ownedSummerLofi],
});
const neutralContext = makeContext({recos: [lofiCandidate, ambientCandidate]});
const performanceProfile = performanceContext.profileForTest();
const neutralProfile = neutralContext.profileForTest();
const lofiBoost = scoreFor(performanceContext, lofiCandidate, performanceProfile)
  - scoreFor(neutralContext, lofiCandidate, neutralProfile);
const ambientBoost = scoreFor(performanceContext, ambientCandidate, performanceProfile)
  - scoreFor(neutralContext, ambientCandidate, neutralProfile);

assert.ok(lofiBoost >= 3,
  'an owned “summer lofi” video without a genre must boost the canonical Lofi recommendation genre');
assert.ok(Math.abs(ambientBoost) <= 0.5,
  'the inferred Lofi performance signal must not leak into an unrelated genre');
assert.ok(
  scoreFor(performanceContext, lofiCandidate, performanceProfile)
    > scoreFor(performanceContext, ambientCandidate, performanceProfile),
  'a strong recent owned-video signal must be able to reverse a small catalogue-score gap',
);

// Refusal learning must target the measured source/seed and its siblings. It
// must not indiscriminately punish every idea that happens to use Lofi Girl.
const refusedSeed = {
  n: -201,
  valid: '-',
  score: 90,
  genre: '🎧 Lofi',
  perso: 'Lofi Girl',
  title: 'Obsidian Monsoon',
  _generated: true,
  _sourceVideoId: 'source-refused',
  _variantSeedN: -9001,
};
const refusedSibling = {
  n: -202,
  valid: '',
  score: 90,
  genre: '🎧 Lofi',
  perso: 'Lofi Girl',
  title: 'Silver Observatory',
  _generated: true,
  _sourceVideoId: 'source-refused',
  _variantSeedN: -9001,
};
const unrelatedSamePersona = {
  n: -203,
  valid: '',
  score: 90,
  genre: '🌌 Ambient',
  perso: 'Lofi Girl',
  title: 'Golden Harbour',
  _generated: true,
  _sourceVideoId: 'source-unrelated',
  _variantSeedN: -9002,
};
const refusalContext = makeContext({recos: [refusedSeed, refusedSibling, unrelatedSamePersona]});
const refusalBaseline = makeContext({
  recos: [Object.assign({}, refusedSeed, {valid: ''}), refusedSibling, unrelatedSamePersona],
});
const refusalProfile = refusalContext.profileForTest();
const refusalBaselineProfile = refusalBaseline.profileForTest();
const siblingDrop = scoreFor(refusalBaseline, refusedSibling, refusalBaselineProfile)
  - scoreFor(refusalContext, refusedSibling, refusalProfile);
const unrelatedDrop = scoreFor(refusalBaseline, unrelatedSamePersona, refusalBaselineProfile)
  - scoreFor(refusalContext, unrelatedSamePersona, refusalProfile);

assert.ok(siblingDrop >= 6,
  'refusing a generated seed must strongly demote variants from the same source/seed');
assert.ok(unrelatedDrop <= 0.75,
  'one refusal must not materially penalize every unrelated idea sharing the same persona');

// A weak measured seed must not be multiplied into filler merely to reach the
// nominal 50-card batch size.
const weakSeed = {
  n: -301,
  valid: '',
  score: 10,
  scoreAdj: 10,
  genre: '🎧 Lofi',
  perso: 'Lofi Girl',
  title: 'Weak Measured Seed',
  concept: 'A low-confidence direction.',
  noteData: 'Measured source below the recommendation quality floor.',
  _generated: true,
  _sourceVideoId: 'weak-source',
  _sourceMarketScore: 10,
};
const weakContext = makeContext({measuredSeeds: [weakSeed]});
const weakProfile = weakContext.profileForTest();
const weakVariants = weakContext.generateVariantsForTest(50, weakProfile, '2026-07-28', {}, {});

assert.equal(weakVariants.length, 0,
  'continuous generation must leave the batch short instead of filling it with variants below the quality threshold');
assert.equal(weakContext.DATA.recos.length, 0,
  'below-threshold continuous variants must not be appended to the recommendation catalogue');

console.log('YouTube recommendation quality learning: OK');

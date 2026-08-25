import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  analyzeEditorialPost,
  buildEditorialAnalysisMap,
  editorialPostKey,
} from "../lib/social-editorial-analysis.ts";

const PUBLIC_HISTORY = JSON.parse(
  readFileSync(new URL("../data/public-history.json", import.meta.url), "utf8"),
);

function post(overrides = {}) {
  return {
    platform: "youtube",
    externalId: "post",
    url: "https://example.test/post",
    title: "A quiet desk today",
    text: "",
    format: "community_text",
    thumbnailUrl: null,
    publishedAt: "2026-08-01T12:00:00.000Z",
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    raw: {},
    ...overrides,
  };
}

function actualPost(externalId) {
  const found = PUBLIC_HISTORY.posts.find(
    (candidate) => candidate.externalId === externalId,
  );
  assert.ok(found, `Expected ${externalId} in the public-history fixture`);
  return found;
}

function actualCohort(target) {
  return PUBLIC_HISTORY.posts.filter(
    (candidate) =>
      candidate.platform === target.platform && candidate.format === target.format,
  );
}

function visibleWhy(analysis) {
  return [
    analysis.headline,
    analysis.mechanism,
    analysis.comparison,
    analysis.transferableLesson,
    ...analysis.mechanisms.flatMap((mechanism) => [
      mechanism.label,
      mechanism.observation,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

function comparativeFixture() {
  return [
    post({
      externalId: "micro-win",
      title: 'not to flex but i moved one task from "to do" to "done"',
      likes: 9_876_543,
      views: 87_654_321,
      comments: 76_543,
      shares: 65_432,
      saves: 54_321,
    }),
    post({
      externalId: "care",
      title: "go to bed.",
      likes: 3_101,
      views: 40_003,
    }),
    post({
      externalId: "commercial",
      title:
        "Our latest release is available now, listen through the link in bio and discover the full collection",
      likes: 2_099,
      views: 31_007,
    }),
    post({
      externalId: "generic",
      title: "A quiet desk today",
      likes: 1_093,
      views: 20_011,
    }),
  ];
}

test("keeps performance metrics, rank and score out of the editorial why", () => {
  const cohort = comparativeFixture();
  const target = cohort[0];
  const analysis = analyzeEditorialPost(target, cohort);
  const copy = visibleWhy(analysis);

  assert.equal(analysis.status, "comparative");
  assert.doesNotMatch(
    copy,
    /\b(?:likes?|vues?|views?|commentaires?|comments?|partages?|shares?|sauvegardes?|saves?|percentile|classement|rang(?:é|ée|ement)?)\b|\bscore\s+(?:de performance|lifetime|normalis[ée])|\/100/i,
  );
  for (const metric of [
    target.likes,
    target.views,
    target.comments,
    target.shares,
    target.saves,
  ]) {
    assert.doesNotMatch(copy, new RegExp(String(metric)));
  }
  assert.match(copy, /action très précise|victoire minuscule|progrès banal/i);
});

test("builds comparisons from the exact platform and format cohort only", () => {
  const cohort = comparativeFixture();
  const target = cohort[0];
  const baseline = analyzeEditorialPost(target, cohort);
  const outsiders = [
    post({
      platform: "tiktok",
      externalId: "other-platform",
      format: "community_text",
      title: target.title,
      likes: 999_999_999,
    }),
    post({
      platform: "youtube",
      externalId: "other-format",
      format: "community_image",
      title: target.title,
      likes: 888_888_888,
    }),
  ];

  const mixed = analyzeEditorialPost(target, [
    outsiders[0],
    ...cohort.toReversed(),
    outsiders[1],
  ]);

  assert.deepEqual(mixed, baseline);
  assert.ok(
    mixed.comparatorPostIds.every((externalId) =>
      cohort.some(
        (candidate) =>
          candidate.externalId === externalId &&
          candidate.platform === target.platform &&
          candidate.format === target.format,
      ),
    ),
  );
  assert.ok(
    mixed.comparatorPostIds.every(
      (externalId) => !outsiders.some((candidate) => candidate.externalId === externalId),
    ),
  );
});

test("is deterministic when cohort order changes and invariant to metric scale", () => {
  const cohort = comparativeFixture();
  const target = cohort[0];
  const baseline = analyzeEditorialPost(target, cohort);
  const reversed = analyzeEditorialPost(target, cohort.toReversed());
  const scaled = cohort.map((candidate) => ({
    ...candidate,
    likes: candidate.likes === null ? null : candidate.likes * 10,
    views: candidate.views === null ? null : candidate.views * 10,
    comments: candidate.comments === null ? null : candidate.comments * 10,
    shares: candidate.shares === null ? null : candidate.shares * 10,
    saves: candidate.saves === null ? null : candidate.saves * 10,
  }));
  const scaledTarget = scaled.find(
    (candidate) => candidate.externalId === target.externalId,
  );

  assert.ok(scaledTarget);
  assert.deepEqual(reversed, baseline);
  assert.deepEqual(analyzeEditorialPost(scaledTarget, scaled), baseline);

  const map = buildEditorialAnalysisMap(cohort.toReversed());
  assert.deepEqual(map.get(editorialPostKey(target)), baseline);
});

test("limits image and video analysis to observable copy and format", () => {
  const image = actualPost("UgkxPVBPcqiFVIIF3xWa_M_Qz_KHYTBo575z");
  const imageAnalysis = analyzeEditorialPost(image, actualCohort(image));
  const video = actualPost("7532570759349226774");
  const videoAnalysis = analyzeEditorialPost(video, actualCohort(video));

  for (const analysis of [imageAnalysis, videoAnalysis]) {
    assert.equal(analysis.scope, "copy-and-format");
    assert.ok(
      analysis.mechanisms
        .flatMap((mechanism) => mechanism.evidence)
        .every((evidence) =>
          ["title", "text", "format", "durationSeconds", "pollChoices"].includes(
            evidence.field,
          ),
        ),
    );
    assert.doesNotMatch(
      visibleWhy(analysis),
      /\b(?:cadrage|palette|couleurs?|composition visuelle|gros plan|mouvement de caméra|expression faciale|transition visuelle)\b|\b(?:l'image|la vidéo|le visuel) (?:montre|révèle|représente)\b/i,
    );
  }

  assert.ok(
    imageAnalysis.limitations.some(
      (limitation) => /image.*(?:n'est pas|n’est pas|pas).*interprétée?/i.test(limitation),
    ),
  );
  assert.ok(
    videoAnalysis.limitations.some(
      (limitation) => /audio.*montage.*(?:ne sont pas|pas).*analysés/i.test(limitation),
    ),
  );
});

test("uses hypotheses without claiming that an editorial feature caused performance", () => {
  const cohort = comparativeFixture();
  const analysis = analyzeEditorialPost(cohort[0], cohort);
  const copy = visibleWhy(analysis);

  assert.doesNotMatch(
    copy,
    /\b(?:prouve|garantit|cause|a causé|explique à lui seul|assure (?:le succès|la performance)|est forcément la raison)\b/i,
  );
});

test("recognizes the real micro-progress post without reducing it to motivation", () => {
  const target = actualPost("Ugkxa0ul261Q-iU9NnzjDxvmyTaCRfvHdPgi");
  const analysis = analyzeEditorialPost(target, actualCohort(target));

  assert.equal(analysis.primarySignal, "micro_progress");
  assert.equal(analysis.status, "comparative");
  assert.match(analysis.headline, /victoire minuscule|micro-victoire/i);
  assert.match(analysis.mechanism, /progrès.*banal|productivité imparfaite/i);
  assert.match(
    analysis.comparison,
    /action très précise|motivation générale|micro-victoire auto-dérisoire|moins distinctive/i,
  );
});

test("recognizes graduado as a student meme rather than music or generic lore", () => {
  const target = actualPost("7532570759349226774");
  const analysis = analyzeEditorialPost(target, actualCohort(target));

  assert.equal(analysis.primarySignal, "student_meme");
  assert.match(analysis.headline, /cap étudiant.*mème/i);
  assert.match(analysis.mechanism, /communauté|formulation.*détournée|chute rejouable/i);
  assert.doesNotMatch(visibleWhy(analysis), /musique.*usage|personnage.*lore/i);
  assert.doesNotMatch(analysis.comparison, /exprime le stress|besoin de soutien/i);
});

test("does not infer a student milestone from generic study hashtags", () => {
  const target = post({
    platform: "tiktok",
    externalId: "final-form",
    format: "video",
    title: "this is not even my final form #lofigirl #studying #fyp",
    likes: 9_000,
  });
  const analysis = analyzeEditorialPost(target, [
    target,
    post({
      platform: "tiktok",
      externalId: "other",
      format: "video",
      title: "quiet desk tonight",
      likes: 100,
    }),
  ]);

  assert.notEqual(analysis.primarySignal, "student_meme");
  assert.doesNotMatch(visibleWhy(analysis), /cap étudiant|étape étudiante/i);
});

test("uses legacy pollTotalVotes with the same public ranking rule", () => {
  const target = post({
    externalId: "z-top-total",
    format: "community_poll",
    title: "If you could delete one season forever, which one would it be?",
    raw: {
      pollTotalVotes: 50_000,
      pollChoices: ["Summer", "Summer", "Summer", "Summer"],
    },
  });
  const analysis = analyzeEditorialPost(target, [
    target,
    post({
      externalId: "a-low-total",
      format: "community_poll",
      title: "What is your favorite drink?",
      raw: { pollTotalVotes: 500, pollChoices: ["Coffee", "Tea"] },
    }),
  ]);

  assert.equal(analysis.primarySignal, "absurd_poll");
  assert.doesNotMatch(analysis.comparison, /moins distinctive/i);
});

test("recognizes the real image post as ironic collective copy without inventing its image", () => {
  const target = actualPost("UgkxPVBPcqiFVIIF3xWa_M_Qz_KHYTBo575z");
  const analysis = analyzeEditorialPost(target, actualCohort(target));

  assert.equal(analysis.primarySignal, "ironic_collective");
  assert.match(analysis.headline, /contraste.*calme.*chaos|complicité/i);
  assert.match(analysis.mechanism, /lecteur|ironie|stress réel/i);
  assert.equal(analysis.scope, "copy-and-format");
});

test("recognizes the real season poll as a native low-friction editorial mechanism", () => {
  const target = actualPost("UgkxxX8OQ6PRa7qf2RwY2lWgNxedRq067MfX");
  const analysis = analyzeEditorialPost(target, actualCohort(target));
  const copy = visibleWhy(analysis);

  assert.equal(analysis.primarySignal, "absurd_poll");
  assert.match(analysis.headline, /sondage.*gag|choix/i);
  assert.match(copy, /mécanique native|prendre position|sans.*réponse longue/i);
  assert.doesNotMatch(copy, /votes?|likes?|\/100/i);
});

test("returns no-differentiator when every peer has the same editorial profile", () => {
  const cohort = [
    post({ externalId: "blue", title: "Blue desk today", likes: 8_000 }),
    post({ externalId: "orange", title: "Orange desk today", likes: 6_000 }),
    post({ externalId: "green", title: "Green desk today", likes: 4_000 }),
    post({ externalId: "purple", title: "Purple desk today", likes: 2_000 }),
  ];
  const analysis = analyzeEditorialPost(cohort[0], cohort);

  assert.equal(analysis.primarySignal, "compressed_hook");
  assert.equal(analysis.status, "no-differentiator");
  assert.deepEqual(analysis.comparatorPostIds, []);
  assert.match(
    analysis.comparison,
    /ne suffisent.*(?:isoler|différence)|aucune différence fiable/i,
  );
  assert.doesNotMatch(analysis.comparison, /celui-ci.*(?:se distingue|explique)/i);
});

test(
  "builds a large mixed editorial cohort without pairwise rescans",
  { timeout: 12_000 },
  () => {
    const patterns = [
      'not to flex but i moved one task from "to do" to "done"',
      "Final exams: we study together, so will you?",
      "Lofi Girl explores Fortnite and uncovers hidden secrets, available now",
      "Lofi Girl final form meme",
      "go to bed, reminder: you got this",
      "not to flex, i'll do it tomorrow",
      "Our new album collection is available now with music for every quiet study session tonight",
      "quiet desk",
    ];
    const cohort = Array.from({ length: 4_000 }, (_, index) =>
      post({
        externalId: `large-${index.toString().padStart(4, "0")}`,
        title: patterns[index % patterns.length],
        publishedAt: new Date(
          Date.UTC(2015, 0, 1) + index * 86_400_000,
        ).toISOString(),
        likes: 10_000 - index,
        views: 100_000 - index * 3,
        comments: index % 300,
      }),
    );

    const startedAt = performance.now();
    const analyses = buildEditorialAnalysisMap(cohort);
    const elapsed = performance.now() - startedAt;
    const comparativeCount = [...analyses.values()].filter(
      (analysis) => analysis.status === "comparative",
    ).length;

    assert.equal(analyses.size, cohort.length);
    assert.ok(comparativeCount > 3_500, "the comparator path must be exercised");
    assert.ok(
      elapsed < 8_000,
      `large editorial cohort took ${Math.round(elapsed)}ms`,
    );
  },
);

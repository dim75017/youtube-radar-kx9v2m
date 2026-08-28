import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { generateSocialIdeas } from "../lib/social-ideas.ts";

const NOW = "2026-08-04T12:00:00.000Z";

function post(overrides = {}) {
  return {
    platform: "youtube",
    externalId: "post",
    url: "https://example.test/post",
    title: "Post",
    text: "",
    format: "short",
    thumbnailUrl: null,
    publishedAt: "2026-08-02T12:00:00.000Z",
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    raw: {},
    ...overrides,
  };
}

function graduationFixture() {
  return [
    post({
      platform: "youtube",
      externalId: "graduado-youtube",
      url: "https://youtube.test/graduado",
      title: "girl i just graduado 🎓",
      format: "short",
      views: 2_510_000,
      likes: 94_800,
      comments: 1_200,
    }),
    post({
      platform: "instagram",
      externalId: "graduado-instagram",
      url: "https://instagram.test/graduado",
      title: "girl i just graduado 🎓",
      format: "reel",
      views: 12_000_000,
      likes: 1_943_000,
      comments: 8_200,
    }),
    post({
      platform: "tiktok",
      externalId: "graduado-tiktok",
      url: "https://tiktok.test/graduado",
      title: "girl i just graduado 🎓",
      format: "video",
      views: 38_000_000,
      likes: 6_200_000,
      comments: 15_000,
    }),
    post({
      platform: "x",
      externalId: "graduado-x",
      url: "https://x.test/graduado",
      title: "girl i just graduado 🎓",
      format: "video",
      views: 16_500_000,
      likes: 257_000,
      comments: 2_700,
    }),
    post({
      platform: "youtube",
      externalId: "graduation-comparison",
      url: "https://youtube.test/graduation-comparison",
      title: "I may not have officially graduated yet",
      format: "community_text",
      likes: 250,
      comments: 12,
    }),
    post({
      platform: "youtube",
      externalId: "unrelated",
      url: "https://youtube.test/unrelated",
      title: "late night focus beats",
      format: "short",
      views: 4_000_000,
      likes: 130_000,
      comments: 2_000,
    }),
  ];
}

test("is deterministic and turns only a directly proven pattern into concrete ideas", () => {
  const posts = graduationFixture();
  const first = generateSocialIdeas(posts, {
    now: NOW,
    maxIdeas: 50,
    winnersPerPlatform: 3,
  });
  const second = generateSocialIdeas([...posts].reverse(), {
    now: NOW,
    maxIdeas: 50,
    winnersPerPlatform: 3,
  });

  assert.deepEqual(first, second);
  assert.equal(first.ideas.length, 5);
  assert.equal(new Set(first.ideas.map((idea) => idea.id)).size, 5);
  assert.ok(
    first.ideas.every(
      (idea) =>
        idea.pattern === "student_milestone_absurdity" &&
        idea.patternLabel === "Étape étudiante + chute absurde",
    ),
  );

  const directIds = new Set([
    "graduado-youtube",
    "graduado-instagram",
    "graduado-tiktok",
    "graduado-x",
  ]);
  for (const idea of first.ideas) {
    assert.ok(idea.seedPosts.length > 0);
    assert.ok(idea.seedPosts.every((seed) => directIds.has(seed.externalId)));
    assert.ok(!idea.seedPosts.some((seed) => seed.externalId === "unrelated"));
    assert.ok(idea.seedPosts.every((seed) => seed.url.startsWith("https://")));
    assert.ok(idea.seedPosts.every((seed) => seed.cohortRank >= 1));
    assert.ok(idea.seedPosts.every((seed) => seed.cohortSize >= seed.cohortRank));
    assert.ok(idea.seedPosts.every((seed) => seed.rankingValue > 0));
    assert.equal(idea.comparisonPost?.externalId, "graduation-comparison");
    assert.match(idea.comparisonInsight ?? "", /version plus longue et promotionnelle/i);
    assert.match(idea.observedSignal.summary, /création directe/i);
    assert.ok(idea.observedSignal.evidence.every((evidence) => /https:\/\//.test(evidence)));
  }
});

test("exposes an understandable post concept, ready copy and the exact borrowed mechanic", () => {
  const plan = generateSocialIdeas(graduationFixture(), { now: NOW, maxIdeas: 5 });

  for (const idea of plan.ideas) {
    assert.ok(idea.title.length >= 20);
    assert.ok(idea.contentType.length > 0);
    assert.ok(idea.proposedFormat.length >= 70);
    assert.ok(idea.hook.length >= 20);
    assert.ok(idea.whyItWorked.length >= 100);
    assert.ok(idea.borrowedMechanic.length >= 80);
    assert.ok(idea.novelty.length >= 60);
    assert.match(idea.proofLabel, /Preuve (?:très forte|forte|solide|directe)/i);
    assert.ok(idea.potentialScore >= 1 && idea.potentialScore <= 100);
    assert.ok(idea.confidenceScore >= 1 && idea.confidenceScore <= 95);
    assert.match(idea.confidenceRationale, /création directe/i);
  }
});

test("does not invent recommendations when no historical post matches a proven family", () => {
  const plan = generateSocialIdeas(
    [
      post({
        platform: "instagram",
        externalId: "generic-high-performer",
        title: "late night focus beats",
        format: "reel",
        views: 30_000_000,
        likes: 4_000_000,
      }),
    ],
    { now: NOW, maxIdeas: 50 },
  );

  assert.equal(plan.eligiblePostCount, 1);
  assert.equal(plan.winnerCount, 1);
  assert.deepEqual(plan.ideas, []);
});

test("never uses comments or replies as performance proof", () => {
  const plan = generateSocialIdeas(
    [
      post({
        externalId: "real-short",
        title: "girl i just graduado",
        format: "short",
        views: 900_000,
        likes: 90_000,
      }),
      post({
        externalId: "youtube-comment",
        title: "girl i just graduado",
        format: "comment",
        views: 90_000_000,
        likes: 9_000_000,
      }),
      post({
        platform: "instagram",
        externalId: "instagram-reply",
        title: "girl i just graduado",
        format: "creator-comment",
        views: 80_000_000,
        likes: 8_000_000,
      }),
      post({
        platform: "tiktok",
        externalId: "tiktok-replies",
        title: "girl i just graduado",
        format: "replies",
        views: 70_000_000,
        likes: 7_000_000,
      }),
    ],
    { now: NOW, maxIdeas: 50 },
  );

  assert.equal(plan.eligiblePostCount, 1);
  assert.ok(plan.ideas.length > 0);
  assert.deepEqual(
    [...new Set(plan.ideas.flatMap((idea) => idea.seedPosts.map((seed) => seed.externalId)))],
    ["real-short"],
  );
});

test("keeps every recommendation platform-neutral and applies the no-AI asset policy", () => {
  const plan = generateSocialIdeas(graduationFixture(), { now: NOW, maxIdeas: 50 });
  const platformTerms = /\b(?:YouTube|Instagram|TikTok|Twitter|X|Shorts?|Reels?|thread)\b/i;

  assert.ok(plan.ideas.length > 0);
  for (const idea of plan.ideas) {
    const proposal = [
      idea.title,
      idea.contentType,
      idea.proposedFormat,
      idea.hook,
      idea.whyItWorked,
      idea.borrowedMechanic,
      idea.novelty,
    ].join(" ");
    assert.doesNotMatch(proposal, platformTerms);
    assert.equal("platformAdaptations" in idea, false);
    assert.equal(idea.assetPolicy, "official-assets-only");
    assert.ok(
      idea.limits.some((limit) =>
        /Aucun visuel ni aucune musique générés par IA/i.test(limit),
      ),
    );
    assert.ok(idea.limits.some((limit) => /ne garantissent pas le résultat/i.test(limit)));
  }
  assert.ok(
    plan.caveats.some((caveat) =>
      /Aucun visuel ni aucune musique générés par IA/i.test(caveat),
    ),
  );
  assert.ok(
    plan.caveats.some((caveat) =>
      /aucun test exploratoire n’est mélangé au classement/i.test(caveat),
    ),
  );
});

test("uses a stable data-derived reference time when now is omitted", () => {
  const posts = [
    post({
      externalId: "graduado",
      title: "girl i just graduado",
      views: 2_000,
    }),
    post({
      externalId: "other",
      title: "late night focus beats",
      views: 1_000,
    }),
  ];

  const first = generateSocialIdeas(posts);
  const second = generateSocialIdeas(posts);

  assert.equal(first.generatedAt, "2026-08-03T12:00:00.000Z");
  assert.deepEqual(first, second);
});

test("real public history yields a complete proof-first portfolio of 50 ideas", () => {
  const history = JSON.parse(
    fs.readFileSync(new URL("../data/public-history.json", import.meta.url), "utf8"),
  );
  const plan = generateSocialIdeas(history.posts, {
    now: history.generatedAt,
    maxIdeas: 500,
    winnersPerPlatform: 8,
  });

  assert.equal(plan.ideas.length, 50);
  assert.equal(new Set(plan.ideas.map((idea) => idea.id)).size, 50);
  assert.equal(plan.ideas[0].title, "Le diplôme pour une seule tâche terminée");
  assert.ok(Math.max(...plan.ideas.map((idea) => idea.potentialScore)) <= 98);
  assert.ok(Math.max(...plan.ideas.map((idea) => idea.confidenceScore)) < 95);
  assert.ok(
    new Set(
      plan.ideas.map((idea) =>
        idea.seedPosts.map((seed) => `${seed.platform}:${seed.externalId}`).sort().join("|"),
      ),
    ).size >= 40,
  );
  assert.ok(plan.eligiblePostCount >= 6_500);
  assert.equal(plan.winnerCount, 80);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(plan.ideas.map((idea) => idea.pattern))]
        .sort()
        .map((pattern) => [
          pattern,
          plan.ideas.filter((idea) => idea.pattern === pattern).length,
        ]),
    ),
    {
      audience_inner_voice: 5,
      cat_conflict: 5,
      consequential_participation: 4,
      cultural_meme_reframe: 5,
      friendly_care: 4,
      iconic_world_remix: 4,
      immersive_activation: 4,
      instant_identity_question: 5,
      narrative_anomaly: 4,
      routine_interruption: 5,
      student_milestone_absurdity: 5,
    },
  );

  const graduationIdea = plan.ideas.find(
    (idea) => idea.title === "Le diplôme pour une seule tâche terminée",
  );
  assert.ok(graduationIdea);
  assert.deepEqual(
    graduationIdea.seedPosts.map((seed) => seed.externalId),
    [
      "7532570759349226774",
      "DMs3O7yA5X7",
      "1950255002163040428",
      "k_xzPBp14rw",
    ],
  );
  assert.ok(graduationIdea.seedPosts.every((seed) => seed.rankingValue > 0));
  const canonEventIdea = plan.ideas.find(
    (idea) => idea.title === "Le canon event de chaque étudiant",
  );
  assert.ok(canonEventIdea);
  assert.deepEqual(
    new Set(canonEventIdea.seedPosts.map((seed) => seed.externalId)),
    new Set([
      "7491754238268263702",
      "DIRsDHxAs7d",
      "7MD-VEewJN0",
      "1910402592284565965",
    ]),
  );
  const testScoreIdea = plan.ideas.find(
    (idea) => idea.title === "Lofi Girl cache sa note, le chat la révèle",
  );
  assert.ok(testScoreIdea);
  assert.deepEqual(
    new Set(testScoreIdea.seedPosts.map((seed) => seed.externalId)),
    new Set(["R3ZgAPR-zek", "7208271408940551429"]),
  );
  assert.ok(plan.ideas.every((idea) => idea.seedPosts.length > 0));
  assert.ok(
    plan.ideas.every(
      (idea) =>
        !idea.limits.some((limit) => /sans précédent direct|exploratoire/i.test(limit)) &&
        /création(?:s)? directe/i.test(idea.observedSignal.summary),
    ),
  );
});

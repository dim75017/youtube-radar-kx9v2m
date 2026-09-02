import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  opportunityIdFor,
  parseAtomEntries,
  qualifiesForBoard,
  refreshCommentOpportunities,
  selectBoard,
} from "../scripts/refresh-comment-opportunities.mjs";
import { assertCommentOpportunityFeed } from "../lib/comment-opportunities.ts";
import { commentOpportunityWhyNow } from "../lib/comment-scoring.ts";

function atomFeed(channelName, entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>${channelName}</title>
 ${entries.map((entry) => `<entry>
  <yt:videoId>${entry.videoId}</yt:videoId>
  <title>${entry.title}</title>
  <author><name>${channelName}</name></author>
  <published>${entry.publishedAt}</published>
  <media:group>
   <media:thumbnail url="https://i1.ytimg.com/vi/${entry.videoId}/hqdefault.jpg" width="480" height="360"/>
   <media:description>${entry.description ?? entry.title}</media:description>
   <media:community>
    <media:starRating count="1086" average="5.00" min="1" max="5"/>
    <media:statistics views="${entry.views}"/>
   </media:community>
  </media:group>
 </entry>`).join("\n")}
</feed>`;
}

const WATCHLIST = {
  version: 1,
  resolvedAt: "2026-08-13T00:00:00Z",
  accounts: [
    {
      handle: "@rockstargames",
      name: "Rockstar Games",
      category: "gaming",
      accountTier: "s",
      youtubeChannelId: "UC6VcWc1rAoWdBCM0JxrRQ3A",
    },
    {
      handle: "@quietchannel",
      name: "Quiet Channel",
      category: "other",
      accountTier: "b",
      youtubeChannelId: "UC0000000000000000000000",
    },
  ],
};

const EMPTY_FEED = {
  version: 2,
  capturedAt: "2026-08-13T09:00:00.000Z",
  nextRefreshAt: "2026-08-13T15:00:00.000Z",
  cadenceHours: 6,
  fastLaneMinutes: 15,
  fastLaneCheckedAt: null,
  watchlistAccountCount: 2,
  sourceChecks: ["youtube", "instagram", "tiktok", "x"].map((platform) => ({
    id: `${platform}-native-public`,
    platform,
    status: "limited",
    checkedAt: "2026-08-13T09:00:00.000Z",
    label: `${platform} · état initial`,
  })),
  opportunities: [],
};

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "comment-radar-"));
  const paths = {
    feed: join(dir, "feed.json"),
    watchlist: join(dir, "watchlist.json"),
    candidates: join(dir, "candidates.json"),
    status: join(dir, "refresh-status.json"),
  };
  await writeFile(paths.feed, JSON.stringify(EMPTY_FEED), "utf8");
  await writeFile(paths.watchlist, JSON.stringify(WATCHLIST), "utf8");
  return paths;
}

test("the Atom parser reads what the fast lane depends on", () => {
  const entries = parseAtomEntries(
    atomFeed("Rockstar Games", [
      {
        videoId: "QdBZY2fkU-0",
        title: "Grand Theft Auto VI Trailer 3 &amp; more",
        publishedAt: "2026-08-13T10:00:00+00:00",
        views: 4_210_000,
      },
    ]),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, "QdBZY2fkU-0");
  assert.equal(entries[0].title, "Grand Theft Auto VI Trailer 3 & more");
  assert.equal(entries[0].author, "Rockstar Games");
  assert.equal(entries[0].publishedAt, "2026-08-13T10:00:00.000Z");
  assert.equal(entries[0].views, 4_210_000);
  assert.equal(entries[0].thumbnailUrl, "https://i1.ytimg.com/vi/QdBZY2fkU-0/hqdefault.jpg");
  assert.equal(parseAtomEntries("<feed></feed>").length, 0);
});

test("ids are deterministic, so the local done queue survives a refresh", () => {
  assert.equal(opportunityIdFor("youtube", "QdBZY2fkU-0"), opportunityIdFor("youtube", "QdBZY2fkU-0"));
  assert.notEqual(opportunityIdFor("youtube", "QdBZY2fkU-0"), opportunityIdFor("youtube", "qdbzy2fku-0"));
  assert.match(opportunityIdFor("youtube", "QdBZY2fkU-0"), /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
});

test("the board bar keeps ordinary uploads out and lets a real moment through", () => {
  const base = { momentTier: "b", lofiFitScore: 60, metrics: { views: 20_000 } };
  assert.equal(qualifiesForBoard(base), false);
  assert.equal(qualifiesForBoard({ ...base, momentTier: "a", lofiFitScore: 70 }), true);
  assert.equal(qualifiesForBoard({ ...base, momentTier: "a", lofiFitScore: 40 }), false);
  assert.equal(qualifiesForBoard({ ...base, momentTier: "s", lofiFitScore: 70 }), true);
});

test("why now reports a real like counter when a public source exposes no views", () => {
  const whyNow = commentOpportunityWhyNow({
    author: "@Fortnite",
    publishedAt: "2026-08-25T13:01:05.000Z",
    capturedAt: "2026-08-28T07:59:09.037Z",
    discovery: { source: "viral-scan", accountHandle: null, accountTier: null },
    velocity: null,
    metrics: { views: null, likes: 33_435, comments: 628, shares: 3_949 },
    momentTier: "b",
  });
  assert.match(whyNow, /33[\s\u202f]435 likes/u);
  assert.doesNotMatch(whyNow, /indisponibles/u);
});

test("sensitive and sponsored uploads never reach the comment board", () => {
  const major = {
    momentTier: "s",
    lofiFitScore: 100,
    metrics: { views: 9_000_000 },
    title: "UNABOMBER | Official Trailer",
    caption: "A new documentary trailer.",
  };
  assert.equal(qualifiesForBoard(major), false);
  assert.equal(
    qualifiesForBoard({
      ...major,
      title: '"I Want To Die" | Episode 9',
      caption: "A dramatic scene.",
    }),
    false,
  );
  assert.equal(
    qualifiesForBoard({
      ...major,
      title: "PlayGalaxy Cup World Final",
      caption: "The full match. #sponsored",
    }),
    false,
  );
  const staleBoard = [
    {
      ...major,
      id: "unsafe-old-card",
      platform: "x",
      author: "@example",
      title: "Too sleepy to function",
      caption: "So sleepy it feels drunk",
      priorityScore: 100,
      publishedAt: "2026-08-08T00:00:00.000Z",
      capturedAt: "2026-08-18T00:00:00.000Z",
      status: "hot",
      risk: { level: "medium", note: "Safety review required." },
    },
  ];
  assert.deepEqual(
    selectBoard(staleBoard, Date.parse("2026-08-28T08:00:00.000Z"), "2026-08-28T08:00:00.000Z"),
    [],
  );
  assert.deepEqual(
    selectBoard(
      [{
        ...staleBoard[0],
        id: "neutral-medium-risk-card",
        title: "A quiet desk setup",
        caption: "A calm afternoon workspace tour.",
      }],
      Date.parse("2026-08-28T08:00:00.000Z"),
      "2026-08-28T08:00:00.000Z",
    ),
    [],
  );
  assert.equal(
    qualifiesForBoard({
      ...major,
      title: "A quiet desk setup",
      caption: "A calm afternoon workspace tour.",
      risk: { level: "medium", note: "Manual review required." },
    }),
    false,
  );
});

test("a drop is discovered, then promoted once the climb is measured", async () => {
  const paths = await workspace();
  const drop = {
    videoId: "QdBZY2fkU-0",
    title: "Grand Theft Auto VI Trailer 3",
    description: "Coming soon. A trailer for the next chapter.",
    publishedAt: "2026-08-13T10:00:00+00:00",
  };
  const filler = {
    videoId: "aaaaaaaaaaa",
    title: "Weekly patch notes rundown",
    description: "A short spec sheet rundown for the weekly patch.",
    publishedAt: "2026-08-13T09:00:00+00:00",
  };

  const fetchImpl = (views) => async (url) => {
    if (url.includes("UC6VcWc1rAoWdBCM0JxrRQ3A")) {
      return new Response(atomFeed("Rockstar Games", [{ ...drop, views }]), { status: 200 });
    }
    return new Response(atomFeed("Quiet Channel", [{ ...filler, views: 900 }]), { status: 200 });
  };

  const first = await refreshCommentOpportunities({
    lane: "fast",
    allowFallback: true,
    now: "2026-08-13T10:10:00.000Z",
    apiKey: "",
    paths,
    fetchImpl: fetchImpl(120_000),
    log: () => {},
  });
  assert.equal(first.status.discovered, 2, "both uploads are tracked as candidates");
  assert.equal(first.status.promoted, 1, "only the s-tier drop reaches the board");
  assert.equal(first.feed.opportunities.length, 1);
  assert.equal(first.feed.opportunities[0].momentTier, "a", "one reading is a drop, not yet a climb");
  assert.equal(first.feed.opportunities[0].velocity, null);
  assert.equal(first.feed.opportunities[0].discovery.accountHandle, "@rockstargames");
  assert.equal(first.feed.opportunities[0].commentsSource, "fallback");
  assert.equal(first.feed.opportunities[0].url, "https://www.youtube.com/watch?v=QdBZY2fkU-0");

  const second = await refreshCommentOpportunities({
    lane: "fast",
    allowFallback: true,
    now: "2026-08-13T10:40:00.000Z",
    apiKey: "",
    paths,
    fetchImpl: fetchImpl(1_020_000),
    log: () => {},
  });
  const card = second.feed.opportunities.find((item) => item.title === drop.title);
  assert.ok(card, "the drop stays on the board");
  assert.deepEqual(card.velocity, {
    metric: "views",
    perHour: 1_800_000,
    windowHours: 0.5,
    fromCapturedAt: "2026-08-13T10:10:00.000Z",
    toCapturedAt: "2026-08-13T10:40:00.000Z",
  });
  assert.equal(card.momentTier, "s", "a measured climb of that size is a major moment");
  assert.equal(card.status, "surging");
  assert.equal(assertCommentOpportunityFeed(second.feed), second.feed);

  const persisted = JSON.parse(await readFile(paths.feed, "utf8"));
  assert.equal(assertCommentOpportunityFeed(persisted), persisted);
  assert.equal(persisted.fastLaneCheckedAt, "2026-08-13T10:40:00.000Z");
  assert.equal(persisted.watchlistAccountCount, 2);
});

test("an unreachable channel degrades the source check instead of emptying the board", async () => {
  const paths = await workspace();
  const drop = {
    videoId: "QdBZY2fkU-0",
    title: "Grand Theft Auto VI Trailer 3",
    publishedAt: "2026-08-13T10:00:00+00:00",
    views: 9_000_000,
  };

  const healthy = await refreshCommentOpportunities({
    lane: "fast",
    allowFallback: true,
    now: "2026-08-13T10:10:00.000Z",
    apiKey: "",
    paths,
    fetchImpl: async (url) =>
      url.includes("UC6VcWc1rAoWdBCM0JxrRQ3A")
        ? new Response(atomFeed("Rockstar Games", [drop]), { status: 200 })
        : new Response(atomFeed("Quiet Channel", []), { status: 200 }),
    log: () => {},
  });
  assert.equal(
    healthy.feed.sourceChecks.find((check) => check.platform === "youtube").status,
    "success",
  );

  const degraded = await refreshCommentOpportunities({
    lane: "fast",
    allowFallback: true,
    now: "2026-08-13T10:40:00.000Z",
    apiKey: "",
    paths,
    fetchImpl: async (url) =>
      url.includes("UC6VcWc1rAoWdBCM0JxrRQ3A")
        ? new Response(atomFeed("Rockstar Games", [drop]), { status: 200 })
        : new Response("nope", { status: 503 }),
    log: () => {},
  });
  const check = degraded.feed.sourceChecks.find((item) => item.platform === "youtube");
  assert.equal(check.status, "limited");
  assert.match(check.label, /1 injoignables/u);
  assert.ok(degraded.feed.opportunities.length >= 1, "the verified card is still there");

  await assert.rejects(
    refreshCommentOpportunities({
      lane: "fast",
      now: "2026-08-13T11:10:00.000Z",
      apiKey: "",
      paths,
      fetchImpl: async () => new Response("nope", { status: 500 }),
      log: () => {},
    }),
    /Aucun flux/u,
    "a total blackout aborts rather than publishing an empty snapshot",
  );
});

test("the same video seen twice in one run does not create two cards", async () => {
  const paths = await workspace();
  const entry = {
    videoId: "QdBZY2fkU-0",
    title: "Grand Theft Auto VI Trailer 3",
    publishedAt: "2026-08-13T10:00:00+00:00",
    views: 9_000_000,
  };
  const result = await refreshCommentOpportunities({
    lane: "fast",
    allowFallback: true,
    now: "2026-08-13T10:10:00.000Z",
    apiKey: "",
    paths,
    // Both watched channels report the same upload, as a re-upload or a
    // secondary channel would.
    fetchImpl: async () => new Response(atomFeed("Rockstar Games", [entry, entry]), { status: 200 }),
    log: () => {},
  });
  assert.equal(result.feed.opportunities.length, 1);
  assert.equal(assertCommentOpportunityFeed(result.feed), result.feed);
});

test("an unmapped card cannot replace the last feed with generic fallbacks", async () => {
  const paths = await workspace();
  const previousFeed = await readFile(paths.feed, "utf8");
  const entry = {
    videoId: "QdBZY2fkU-0",
    title: "Grand Theft Auto VI Trailer 3",
    description: "Coming soon. A trailer for the next chapter.",
    publishedAt: "2026-08-13T10:00:00+00:00",
    views: 9_000_000,
  };

  await assert.rejects(
    refreshCommentOpportunities({
      lane: "fast",
      now: "2026-08-13T10:10:00.000Z",
      apiKey: "",
      paths,
      fetchImpl: async (url) =>
        url.includes("UC6VcWc1rAoWdBCM0JxrRQ3A")
          ? new Response(atomFeed("Rockstar Games", [entry]), { status: 200 })
          : new Response(atomFeed("Quiet Channel", []), { status: 200 }),
      log: () => {},
    }),
    /sans commentaires éditoriaux spécifiques/u,
  );

  assert.equal(
    await readFile(paths.feed, "utf8"),
    previousFeed,
    "the last verified snapshot stays byte-for-byte intact",
  );
  const status = JSON.parse(await readFile(paths.status, "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.ranAt, "2026-08-13T10:10:00.000Z");
  assert.equal(status.pendingEditorialCount, 1);
  assert.equal(status.attemptedCards, 1);
  assert.equal(status.published, 0);
  assert.equal(status.retainedFeedCapturedAt, EMPTY_FEED.capturedAt);
  assert.match(status.failureReason, /dernier snapshot conservé/u);
  const candidates = JSON.parse(await readFile(paths.candidates, "utf8"));
  assert.equal(candidates.updatedAt, "2026-08-13T10:10:00.000Z");
  assert.ok(candidates.candidates.length >= 1);
});

test("a YouTube-only lane preserves the last verified cards from every other platform", async () => {
  const currentFeed = JSON.parse(
    await readFile(new URL("../data/comment-opportunities/feed.json", import.meta.url), "utf8"),
  );
  const opportunities = currentFeed.opportunities.map((opportunity) => ({
    ...structuredClone(opportunity),
    publishedAt:
      opportunity.platform === "youtube"
        ? "2026-08-18T12:00:00.000Z"
        : "2026-07-01T12:00:00.000Z",
  }));

  const selected = selectBoard(
    opportunities,
    Date.parse("2026-08-18T18:00:00.000Z"),
    "2026-08-18T18:00:00.000Z",
  );

  assert.ok(selected.length <= 30);
  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    assert.ok(
      selected.filter((item) => item.platform === platform).length >= 4,
      `missing preserved ${platform} cards`,
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLofiCommentPrompt,
  curatedLofiComments,
  fallbackLofiComments,
  LOFI_COMMENT_ARCHETYPES,
  LOFI_VOICE_HALL_OF_FAME,
  parseLofiVoiceResponse,
  requestLofiComments,
  validateLofiComment,
} from "../lib/lofi-voice.ts";
import { isPromotionalComment } from "../lib/comment-opportunities.ts";

const sampleOpportunity = {
  platform: "youtube",
  category: "gaming",
  author: "Rockstar Games",
  title: "Grand Theft Auto VI Trailer 3",
  caption: "Coming May 2027.",
  momentTier: "s",
  metrics: { views: 12_000_000, likes: null, comments: null, shares: null },
  velocity: {
    metric: "views",
    perHour: 1_200_000,
    windowHours: 0.5,
    fromCapturedAt: "2026-08-13T10:00:00Z",
    toCapturedAt: "2026-08-13T10:30:00Z",
  },
  publishedAt: "2026-08-13T10:00:00Z",
};

test("the guard refuses everything a brand account must never post", () => {
  assert.equal(validateLofiComment("ok i will put my pen down for this one").ok, true);
  assert.equal(validateLofiComment("").ok, false);
  assert.equal(validateLofiComment(" leading space").ok, false);
  assert.equal(validateLofiComment("two\nlines").ok, false);
  assert.equal(validateLofiComment("go check out our playlist").ok, false);
  assert.equal(validateLofiComment("listen here https://example.com").ok, false);
  assert.equal(validateLofiComment("nice #lofi").ok, false);
  assert.equal(validateLofiComment("rip to a legend").ok, false);
  assert.equal(validateLofiComment("i want to die").ok, false);
  assert.equal(validateLofiComment("🔥🔥 this goes hard").ok, false);
  assert.equal(validateLofiComment("as an ai i loved this").ok, false);
  assert.equal(validateLofiComment("a".repeat(161)).ok, false);
  assert.equal(validateLofiComment("a".repeat(160)).ok, true);
});

test("the reference line that worked still passes its own guard", () => {
  assert.ok(LOFI_VOICE_HALL_OF_FAME.length > 0);
  for (const entry of LOFI_VOICE_HALL_OF_FAME) {
    assert.equal(validateLofiComment(entry.comment).ok, true, entry.comment);
  }
  for (const archetype of LOFI_COMMENT_ARCHETYPES) {
    assert.equal(validateLofiComment(archetype.example).ok, true, archetype.example);
  }
});

test("the prompt carries the canon, the archetypes and the measured facts", () => {
  const prompt = buildLofiCommentPrompt(sampleOpportunity);
  assert.match(prompt.system, /Pocky/u);
  assert.match(prompt.system, /put my pen down/u);
  assert.match(prompt.system, /pen-down/u);
  assert.match(prompt.system, /160 caractères maximum/u);
  assert.match(prompt.user, /Rockstar Games/u);
  assert.match(prompt.user, /Grand Theft Auto VI Trailer 3/u);
  assert.match(prompt.user, /1\s?200\s?000 views par heure/u);
  assert.match(prompt.user, /moment culturel majeur/u);
});

test("a triplet is accepted only when all three tones survive the guard", () => {
  const good = parseLofiVoiceResponse(`{"usable":true,"comments":[
    {"tone":"funny","archetype":"pen-down","text":"ok i will put my pen down for this one"},
    {"tone":"smart","archetype":"the-loop","text":"i was already at this desk when the last one came out"},
    {"tone":"complice","archetype":"deadline","text":"nobody in this comment section is working tomorrow"}
  ]}`);
  assert.equal(good.usable, true);
  assert.deepEqual(good.comments.map((comment) => comment.tone), ["funny", "smart", "complice"]);
  assert.deepEqual(good.comments.map((comment) => comment.label), ["Drôle", "Smart", "Complice"]);

  const oneBad = parseLofiVoiceResponse(`{"usable":true,"comments":[
    {"tone":"funny","text":"ok i will put my pen down for this one"},
    {"tone":"smart","text":"go follow them right now"},
    {"tone":"complice","text":"see you in the replies"}
  ]}`);
  assert.equal(oneBad.usable, false, "one unusable line invalidates the whole triplet");
  assert.match(oneBad.reason, /smart/u);

  assert.equal(parseLofiVoiceResponse("not json at all").usable, false);
  assert.equal(parseLofiVoiceResponse(`{"usable":false,"reason":"deuil"}`).usable, false);
  assert.equal(
    parseLofiVoiceResponse(`{"usable":true,"comments":[
      {"tone":"funny","text":"same line"},
      {"tone":"smart","text":"same line"},
      {"tone":"complice","text":"another line"}
    ]}`).usable,
    false,
    "three proposals that are two proposals are refused",
  );
});

test("the model answer survives the prose models like to wrap JSON in", () => {
  const parsed = parseLofiVoiceResponse(`Voici les propositions :
\`\`\`json
{"usable":true,"comments":[
  {"tone":"funny","text":"new phone, same three apps"},
  {"tone":"smart","text":"the interesting part is always what they stopped shipping"},
  {"tone":"complice","text":"the annual ritual, on time as always"}
]}
\`\`\``);
  assert.equal(parsed.usable, true);
});

test("fallback lines are stable, metadata-specific and globally distinct", () => {
  const opportunity = {
    id: "yt-abc-123456",
    title: "Grand Theft Auto VI Trailer 3",
    caption: "Coming May 2027.",
    author: "Rockstar Games",
  };
  const first = fallbackLofiComments(opportunity);
  const again = fallbackLofiComments(opportunity);
  assert.deepEqual(first, again, "the same card must not shuffle its fallback on every run");
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((comment) => comment.text)).size, 3);
  for (const comment of first) {
    assert.match(comment.text, /grand theft auto vi/u);
    assert.equal(validateLofiComment(comment.text).ok, true, comment.text);
    assert.equal(isPromotionalComment(comment.text), false, comment.text);
    const wordCount = comment.text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    assert.ok(wordCount >= 8 && wordCount <= 18, `${wordCount} words: ${comment.text}`);
  }

  const reserved = new Set();
  const sharedTitle = { title: "Official Trailer", caption: "A moonlit train arrives.", author: "Studio" };
  const one = fallbackLofiComments({ ...sharedTitle, id: "yt-one-123456" }, reserved);
  const two = fallbackLofiComments({ ...sharedTitle, id: "yt-two-123456" }, reserved);
  assert.equal(new Set([...one, ...two].map((comment) => comment.text)).size, 6);
  for (const comment of [...one, ...two]) {
    assert.match(comment.text, /moonlit train arrives/u, "boilerplate title must yield to caption detail");
  }
});

test("current editorial overrides are specific, concise and globally unique", () => {
  const expectedAnchors = {
    "yt-meoj92ztopa-ab0a1a": /707|functional authenticity|famous flyer/u,
    "yt-aa4pyww2cyc-33e8bb": /every game|not ending|kai cenat/u,
    "yt-mt4bk1lw8g-4ced59": /bloody paradise|sin\s*:\s*bliss|hattrick/u,
    "yt-cn0drh49us-809077": /snow|fog|frost|dreamscape|wandering journey/u,
    "yt-5rkhlxnknhu-6a67e0": /sauron|fear no darkness|nintendo switch 2|the north/u,
    "yt-49mtrzblgda-4b959a": /onslaught|adam wingard|september 4/u,
    "yt-fow9bq3mbq8-e2a29a": /zero hour|breach|ai squadmates/u,
    "yt-wrss65uindu-5ec3f7": /pitt|season three|back to it|january return/u,
    "yt-bhyr1bpbyy-300fc3": /world cup|halftime|bts|2026/u,
    "yt-2x4ayn9a9ao-4efaa0": /demon want(?:ed|ing) more|big eyes|episode one/u,
    "yt-qawbxet88o-89d8d9": /chip|dude perfect|bryson/u,
    "yt-syehkmfswhk-7d3ce1": /night city|standalone ten-episode|october 20/u,
    "yt-wkra3yuozkm-fb4f11": /bloody paradise|enhypen/u,
    "yt-rvzvq0qazvq-b4677a": /cod next|6v6|warzone|zodiac|modern warfare 4/u,
    "yt-on7ifwoihew-b160c1": /counter-strike|caught up in the moment|ludwig/u,
    "yt-9rmxngbvpa-acb791": /space whale|stars|october 15/u,
    "yt-vnz0dfvqj5m-168416": /terminal list|official teaser|prime video/u,
    "yt-8b07gufyuji-5cc71d": /ruche|game system|weakest class|big-ticket/u,
    "yt-f0qgxeaike-ed7481": /bachiko|natural enemy|season four/u,
    "yt-mfmdxpt7nam-89978d": /every email|one month|again|inbox/u,
    "yt-avwffq3xlyc-8ace84": /xbox|s\.t\.a\.l\.k\.e\.r\.|mortal shell ii|call of duty|forza/u,
    "yt-um3k9v4lkoa-0dedd8": /ito|syu|only child|eldest sister/u,
    "yt-nna95q3pzto-513663": /nba star|impossible shot|dude perfect/u,
    "yt-sdhz4gzglkg-6b1850": /final arc|3v3|september 4|nintendo switch 2/u,
    "yt-na14zezutp8-553e91": /cap|red skull|first avenger/u,
    "yt-qegdhu8ptc-076125": /marvel|creator|reaction|december 18/u,
    "yt-yikfqaz3xq-56b83d": /underwater soulslike|crab|crustacean|switch 2|shell/u,
    "yt-rrfjvp6quw-b08616": /twenty hours|h2|noise cancellation|usb-c|spatial audio|five colors/u,
    "yt-encmlxqbvra-5f2506": /tems|what you need|colors moment/u,
    "yt-zxu4v1qjssg-e24592": /new class|netflix icons|emerging talent/u,
    "yt-tjbzmqjgh4k-4e05af": /extended look|gta vi|game mechanic/u,
    "yt-zvcqhurhzwi-533a73": /bini|parallel world|open mic/u,
    "yt-opgr9gc5ozk-4bfbb2": /le sserafim|you just made my night/u,
    "yt-fivctzmv4xo-54f510": /rockstar explain|steal(?:ing)? cars|gta 6/u,
    "yt-98fohkdonau-b5b822": /gamescom|day 2|xbox/u,
    "yt-migclaow9ki-76115e": /ishowspeed|live|gta 6 reaction|gta 6 trailer/u,
    "yt-wsm9gtuttbs-91d853": /extended gameplay|gta 6/u,
    "yt-uphthaa97ig-e9c41b": /netflix|now playing|gta vi/u,
    "yt-xe3qx0kxara-462c33": /doomsday|countdown|podcast|special look/u,
    "yt-v3qx5b0geg-e071ed": /avengers|doomsday countdown|podcast/u,
    "yt-ghsrc0r1a2a-160ef2": /tws|soda soda|performance film/u,
    "yt-xwdamnfs6im-185550": /love hypothesis|prime video/u,
    "yt-yqai0oqtt7w-202112": /dust|kurzgesagt/u,
    "yt-q7wqli6pxpe-6d6f4a": /how many bounces|dude perfect/u,
    "yt-t6fxf4pmvvc-bf3b17": /12 12 12|date announcement|apple tv/u,
    "yt-b3kpfdb1pw8-8ce432": /mkbhd|locked iphone|10,000/u,
    "yt-h06xkc1nju-937794": /what did she mean|ludwig|unfinished/u,
    "yt-jvt8p527ngy-55ee51": /fangtopia|monster paradise|beauty or score|friendly ghouls/u,
    "yt-t1erhhdzjk-b1e4bd": /yuru|twins|daemon/u,
    "yt-6lfuc6sqcoe-bf99cb": /live for you|colors moment|thee sacred souls/u,
    "yt-eokbqefivhs-baf207": /newspaper|tabloid|ink/u,
    "yt-elsda0movvc-8d7bf1": /monopoly junior|interactive dice|rent/u,
    "yt-irhtqjhypew-7ff09b": /three generations|emotional inheritance|la bola negra/u,
    "yt-jsgka8npfc-6190d5": /trailer became a game|trailer playable|world warrior tournament|first fight/u,
    "yt-ioimwxbqby-8c14a5": /revenge era|minecraft|inventory slots/u,
    "yt-uflxsgsg870-53c14b": /spider-man|eras|multiverse/u,
    "yt-tmdsa7z4pps-0dbca9": /track check|september 11|release/u,
  };
  const allTexts = [];
  for (const [id, anchor] of Object.entries(expectedAnchors)) {
    const comments = curatedLofiComments({ id });
    assert.equal(comments.length, 3, id);
    assert.deepEqual(comments.map((comment) => comment.tone), ["funny", "smart", "complice"]);
    for (const comment of comments) {
      assert.match(comment.text.toLocaleLowerCase("en"), anchor, `${id}: ${comment.text}`);
      assert.equal(validateLofiComment(comment.text).ok, true, comment.text);
      const wordCount = comment.text.trim().split(/\s+/u).length;
      assert.ok(wordCount >= 8 && wordCount <= 18, `${wordCount} words: ${comment.text}`);
      allTexts.push(comment.text.normalize("NFKC").toLocaleLowerCase("en"));
    }
  }
  assert.equal(new Set(allTexts).size, allTexts.length);
  assert.equal(curatedLofiComments({ id: "yt-unknown-000000" }), null);
});

test("an unavailable voice engine degrades instead of throwing", async () => {
  const result = await requestLofiComments(sampleOpportunity, {
    apiKey: "test-key",
    fetchImpl: async () => new Response("nope", { status: 529 }),
  });
  assert.equal(result.usable, false);
  assert.match(result.reason, /529/u);
});

test("the canon block is sent as a cacheable prefix, once per run", async () => {
  let captured = null;
  await requestLofiComments(sampleOpportunity, {
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{
            type: "text",
            text: `{"usable":true,"comments":[
              {"tone":"funny","text":"ok i will put my pen down for this one"},
              {"tone":"smart","text":"eight years at this desk and this is the interruption"},
              {"tone":"complice","text":"see you all back here in 2027"}
            ]}`,
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(captured.system[0].cache_control.type, "ephemeral");
  assert.equal(captured.messages.length, 1);
  assert.ok(captured.max_tokens > 0);
});

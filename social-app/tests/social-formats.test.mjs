import assert from "node:assert/strict";
import test from "node:test";

import {
  SOCIAL_FORMAT_FILTERS,
  classifySocialFormat,
  formatLabelForPost,
  getFormatFilters,
  getSocialFormatLabel,
  isInScopeSocialPost,
  isSocialFormatPost,
  isYouTubeOutOfScope,
  matchesSocialFormatFilter,
} from "../lib/social-formats.ts";
import { youtubeCommunityAttachmentFormat } from "../lib/social-scanner.ts";

function post(platform, format, overrides = {}) {
  return {
    platform,
    format,
    url: `https://example.test/${platform}/post`,
    title: "Post",
    text: "",
    raw: {},
    ...overrides,
  };
}

test("exposes the exact platform filter labels with an emoji", () => {
  assert.deepEqual(
    getFormatFilters("youtube").map(({ key, label }) => [key, label]),
    [
      ["all", "Tous"],
      ["short", "Shorts"],
      ["community", "Communauté · image"],
      ["poll", "Sondages"],
      ["text", "Texte"],
      ["comment", "Commentaires"],
    ],
  );
  assert.deepEqual(
    getFormatFilters("instagram").map(({ key, label }) => [key, label]),
    [
      ["all", "Tous"],
      ["reel", "Reels"],
      ["static", "Posts statiques"],
      ["comment", "Commentaires"],
    ],
  );
  assert.deepEqual(
    getFormatFilters("tiktok").map(({ key, label }) => [key, label]),
    [
      ["all", "Tous"],
      ["video", "Vidéos"],
      ["comment", "Commentaires"],
    ],
  );
  assert.deepEqual(
    getFormatFilters("x").map(({ key, label }) => [key, label]),
    [
      ["all", "Tous"],
      ["static", "Statique"],
      ["video", "Vidéo"],
      ["text", "Texte"],
    ],
  );
  assert.ok(
    Object.values(SOCIAL_FORMAT_FILTERS)
      .flat()
      .every((filter) => filter.emoji.length > 0),
  );
});

test("keeps YouTube Shorts and community sub-formats in scope", () => {
  const short = post("youtube", "short");
  const poll = post("youtube", "community_poll");
  const text = post("youtube", "community-text");
  const genericCommunity = post("youtube", "image", {
    url: "https://www.youtube.com/post/Ugkx123",
  });
  const unknownCommunity = post("youtube", "community_post", {
    url: "https://www.youtube.com/post/Ugkx456",
  });
  const comment = post("youtube", "channel-comment");

  assert.equal(classifySocialFormat(short), "short");
  assert.equal(classifySocialFormat(poll), "poll");
  assert.equal(classifySocialFormat(text), "text");
  assert.equal(classifySocialFormat(genericCommunity), "community");
  assert.equal(classifySocialFormat(comment), "comment");
  assert.equal(classifySocialFormat(unknownCommunity), null);
  assert.equal(matchesSocialFormatFilter(poll, "poll"), true);
  assert.equal(matchesSocialFormatFilter(poll, "community"), false);
  assert.equal(matchesSocialFormatFilter(text, "community"), false);
  assert.equal(matchesSocialFormatFilter(genericCommunity, "community"), true);
  assert.equal(matchesSocialFormatFilter(comment, "community"), false);
  assert.equal(matchesSocialFormatFilter(comment, "comment"), true);
  assert.equal(getSocialFormatLabel(short), "🎬 Short");
  assert.equal(formatLabelForPost(poll), "🗳️ Sondage");
});

test("explicitly excludes YouTube long videos, livestreams and premieres", () => {
  const longVideo = post("youtube", "video", {
    url: "https://www.youtube.com/watch?v=long",
  });
  const livestream = post("youtube", "livestream", {
    url: "https://www.youtube.com/live/live-id",
  });
  const premiere = post("youtube", "premiere");

  for (const candidate of [longVideo, livestream, premiere]) {
    assert.equal(classifySocialFormat(candidate), "out-of-scope");
    assert.equal(matchesSocialFormatFilter(candidate, "all"), false);
    assert.equal(isInScopeSocialPost(candidate), false);
    assert.equal(isYouTubeOutOfScope(candidate), true);
  }

  const contradictoryShort = post("youtube", "short", {
    url: "https://www.youtube.com/watch?v=legacy-short-label",
    raw: { isShort: true },
  });
  assert.equal(classifySocialFormat(contradictoryShort), "out-of-scope");
  assert.equal(isInScopeSocialPost(contradictoryShort), false);
});

test("keeps only native Community text, image and poll attachments", () => {
  assert.equal(youtubeCommunityAttachmentFormat(null), "community_text");
  assert.equal(
    youtubeCommunityAttachmentFormat({ backstageImageRenderer: { image: {} } }),
    "community_image",
  );
  assert.equal(
    youtubeCommunityAttachmentFormat({ pollRenderer: { choices: [] } }),
    "community_poll",
  );
  assert.equal(
    youtubeCommunityAttachmentFormat({ videoRenderer: { videoId: "long" } }),
    null,
  );
  assert.equal(
    youtubeCommunityAttachmentFormat({ playlistRenderer: { playlistId: "mix" } }),
    null,
  );
});

test("normalizes current and future Instagram, TikTok and X format aliases", () => {
  const instagramReel = post("instagram", "GraphVideo");
  const instagramStatic = post("instagram", "GraphSidecar");
  const instagramComment = post("instagram", "creator_reply");
  const tiktokVideo = post("tiktok", "photo_mode");
  const tiktokComment = post("tiktok", "comment");
  const xStatic = post("x", "post", { raw: { mediaType: "photo" } });
  const xVideo = post("x", "post", { raw: { media: { type: "animated_gif" } } });
  const xText = post("x", "text");
  const xReply = post("x", "reply");

  assert.equal(classifySocialFormat(instagramReel), "reel");
  assert.equal(classifySocialFormat(instagramStatic), "static");
  assert.equal(classifySocialFormat(instagramComment), "comment");
  assert.equal(classifySocialFormat(tiktokVideo), "video");
  assert.equal(classifySocialFormat(tiktokComment), "comment");
  assert.equal(classifySocialFormat(xStatic), "static");
  assert.equal(classifySocialFormat(xVideo), "video");
  assert.equal(classifySocialFormat(xText), "text");
  assert.equal(classifySocialFormat(xReply), "text");

  assert.equal(matchesSocialFormatFilter(instagramReel, "reel"), true);
  assert.equal(matchesSocialFormatFilter(instagramStatic, "static"), true);
  assert.equal(matchesSocialFormatFilter(tiktokVideo, "video"), true);
  assert.equal(matchesSocialFormatFilter(xStatic, "static"), true);
  assert.equal(matchesSocialFormatFilter(xVideo, "video"), true);
  assert.equal(matchesSocialFormatFilter(xText, "text"), true);
});

test("uses URL and raw flags when a future collector has no canonical format yet", () => {
  assert.equal(
    classifySocialFormat(
      post("youtube", "unknown", {
        url: "https://www.youtube.com/shorts/abc",
      }),
    ),
    "short",
  );
  assert.equal(
    classifySocialFormat(
      post("youtube", null, { raw: { payload: { isPoll: true } } }),
    ),
    "poll",
  );
  assert.equal(
    classifySocialFormat(
      post("instagram", "unknown", {
        url: "https://www.instagram.com/reel/abc/",
      }),
    ),
    "reel",
  );
  assert.equal(
    classifySocialFormat(
      post("x", null, {
        url: "https://x.com/lofigirl/status/123",
      }),
    ),
    "text",
  );
});

test("validates untrusted posts and rejects unknown or malformed payloads", () => {
  const valid = post("instagram", "reel");
  const unknown = post("youtube", "future-unknown-format");

  assert.equal(isSocialFormatPost(valid), true);
  assert.equal(isInScopeSocialPost(valid), true);
  assert.equal(isInScopeSocialPost(unknown), false);
  assert.equal(isSocialFormatPost({ platform: "facebook", format: "post" }), false);
  assert.equal(isSocialFormatPost({ platform: "x", format: 42 }), false);
  assert.equal(isSocialFormatPost(null), false);
  assert.equal(getSocialFormatLabel(unknown), "❔ Format inconnu");
});

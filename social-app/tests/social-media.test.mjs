import assert from "node:assert/strict";
import test from "node:test";

import {
  getSocialVideoEmbed,
  getTikTokOEmbedUrl,
  parseTikTokThumbnailUrl,
} from "../lib/social-media.ts";

function post(overrides = {}) {
  return {
    platform: "youtube",
    format: "short",
    external_post_id: "thR75861Btw",
    url: "https://www.youtube.com/shorts/thR75861Btw",
    thumbnail_url: "https://i.ytimg.com/vi/thR75861Btw/hqdefault.jpg",
    ...overrides,
  };
}

test("builds official players for YouTube Shorts and TikTok videos", () => {
  const youtube = getSocialVideoEmbed(post());
  const tiktokPost = post({
    platform: "tiktok",
    format: "video",
    external_post_id: "7532570759349226774",
    url: "https://www.tiktok.com/@lofigirl/video/7532570759349226774",
    thumbnail_url: null,
  });
  const tiktok = getSocialVideoEmbed(tiktokPost);

  assert.equal(
    youtube?.playerUrl,
    "https://www.youtube-nocookie.com/embed/thR75861Btw?autoplay=1&playsinline=1&rel=0",
  );
  assert.equal(
    tiktok?.playerUrl,
    "https://www.tiktok.com/player/v1/7532570759349226774?autoplay=1&controls=1&description=0&music_info=0&rel=0",
  );
  assert.match(getTikTokOEmbedUrl(tiktokPost) ?? "", /tiktok\.com%2F%40lofigirl%2Fvideo/);
});

test("refuses long YouTube videos, lives, Community posts and malformed IDs", () => {
  assert.equal(
    getSocialVideoEmbed(
      post({ format: "video", url: "https://www.youtube.com/watch?v=thR75861Btw" }),
    ),
    null,
  );
  assert.equal(
    getSocialVideoEmbed(
      post({ format: "short", url: "https://www.youtube.com/live/thR75861Btw" }),
    ),
    null,
  );
  assert.equal(
    getSocialVideoEmbed(
      post({
        format: "community_image",
        external_post_id: "UgkxCommunity",
        url: "https://www.youtube.com/post/UgkxCommunity",
      }),
    ),
    null,
  );
  assert.equal(
    getSocialVideoEmbed(
      post({
        platform: "tiktok",
        format: "video",
        external_post_id: "not-an-id",
        url: "https://www.tiktok.com/@lofigirl/video/not-an-id",
      }),
    ),
    null,
  );
  assert.equal(
    getSocialVideoEmbed(
      post({
        platform: "tiktok",
        format: "video",
        external_post_id: "7532570759349226774",
        url: "https://www.tiktok.com/@someoneelse/video/7532570759349226774",
      }),
    ),
    null,
  );
});

test("requires the URL path and external ID to describe the same post", () => {
  assert.equal(
    getSocialVideoEmbed(
      post({ url: "https://www.youtube.com/shorts/E0kzst8woc4" }),
    ),
    null,
  );
  assert.equal(
    getSocialVideoEmbed(
      post({
        platform: "tiktok",
        format: "video",
        external_post_id: "7532570759349226774",
        url: "https://www.tiktok.com/@lofigirl/video/7669126261251362081",
      }),
    ),
    null,
  );
});

test("accepts official TikTok image CDNs and rejects stale or foreign thumbnails", () => {
  const now = 1_785_800_000_000;
  const tiktokCdn = parseTikTokThumbnailUrl(
    "https://p16-common-sign.tiktokcdn-eu.com/image.jpg?x-expires=1786000000",
    now,
  );
  const musCdn = parseTikTokThumbnailUrl(
    "https://p16.muscdn.com/image.jpg?x-expires=1786000000",
    now,
  );

  assert.match(tiktokCdn?.url ?? "", /tiktokcdn-eu\.com/);
  assert.match(musCdn?.url ?? "", /muscdn\.com/);
  assert.equal(
    parseTikTokThumbnailUrl(
      "https://p16.muscdn.com/image.jpg?x-expires=1785700000",
      now,
    ),
    null,
  );
  assert.equal(
    parseTikTokThumbnailUrl(
      "https://tiktokcdn.evil.example/image.jpg?x-expires=1786000000",
      now,
    ),
    null,
  );
});

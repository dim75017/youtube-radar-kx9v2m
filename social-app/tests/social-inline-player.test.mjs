import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSocialInlineEmbedUrl,
  resolveFreshInstagramPlaybackUrl,
} from "../lib/social-inline-player.ts";

const hostOrigin = "https://dim75017.github.io";

test("builds sound-on TikTok and controllable YouTube inline players", () => {
  const tiktok = buildSocialInlineEmbedUrl(
    "tiktok",
    "https://www.tiktok.com/@creator/video/7663570718331768084",
    hostOrigin,
  );
  const youtube = buildSocialInlineEmbedUrl(
    "youtube",
    "https://www.youtube.com/shorts/thR75861Btw",
    hostOrigin,
  );

  assert.equal(
    tiktok,
    "https://www.tiktok.com/player/v1/7663570718331768084?autoplay=1&muted=0&controls=1&volume_control=1&play_button=1&description=0&music_info=0&rel=0",
  );
  assert.match(youtube ?? "", /autoplay=1/);
  assert.match(youtube ?? "", /enablejsapi=1/);
  assert.match(youtube ?? "", /origin=https%3A%2F%2Fdim75017\.github\.io/);
});

test("keeps Instagram and X references inside their official embeds", () => {
  assert.equal(
    buildSocialInlineEmbedUrl(
      "instagram",
      "https://www.instagram.com/reels/DbieVLOsbLT/",
      hostOrigin,
    ),
    "https://www.instagram.com/reel/DbieVLOsbLT/embed/",
  );
  assert.equal(
    buildSocialInlineEmbedUrl(
      "x",
      "https://x.com/creator/status/1234567890123456789",
      hostOrigin,
    ),
    "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&theme=dark&dnt=true",
  );
});

test("accepts only a fresh Instagram CDN MP4 whose signed expiry matches", () => {
  const signedExpiresAt = Date.parse("2026-08-12T12:00:00.000Z");
  const signedExpiry = Math.floor(signedExpiresAt / 1_000).toString(16);
  const playbackUrl = `https://scontent.cdninstagram.com/v/t50.2886-16/reference.mp4?oh=signed-playback-token&oe=${signedExpiry}`;

  assert.equal(
    resolveFreshInstagramPlaybackUrl(
      playbackUrl,
      "2026-08-12T12:00:00.000Z",
      Date.parse("2026-08-12T10:00:00.000Z"),
    ),
    playbackUrl,
  );
  assert.equal(
    resolveFreshInstagramPlaybackUrl(
      playbackUrl,
      "2026-08-12T12:00:00.000Z",
      signedExpiresAt,
    ),
    null,
  );
  assert.equal(
    resolveFreshInstagramPlaybackUrl(
      playbackUrl,
      "2026-08-12T13:00:00.000Z",
      Date.parse("2026-08-12T10:00:00.000Z"),
    ),
    null,
  );
  assert.equal(
    resolveFreshInstagramPlaybackUrl(
      `https://example.com/reference.mp4?oe=${signedExpiry}`,
      "2026-08-12T12:00:00.000Z",
      Date.parse("2026-08-12T10:00:00.000Z"),
    ),
    null,
  );
});

test("rejects foreign hosts, malformed IDs and YouTube embeds without an origin", () => {
  assert.equal(
    buildSocialInlineEmbedUrl(
      "tiktok",
      "https://example.com/@creator/video/7663570718331768084",
      hostOrigin,
    ),
    null,
  );
  assert.equal(
    buildSocialInlineEmbedUrl(
      "youtube",
      "https://www.youtube.com/shorts/thR75861Btw",
    ),
    null,
  );
  assert.equal(
    buildSocialInlineEmbedUrl(
      "instagram",
      "https://www.instagram.com/reel/not/valid/path",
      hostOrigin,
    ),
    null,
  );
});

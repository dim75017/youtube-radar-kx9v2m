import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commentTarget,
  isAuthoredComment,
} from "../lib/authored-comments.ts";

test("separates authored comments from ordinary posts", () => {
  assert.equal(
    isAuthoredComment({
      platform: "youtube",
      format: "comment",
      url: "https://www.youtube.com/watch?v=abc&lc=comment-id",
    }),
    true,
  );
  assert.equal(
    isAuthoredComment({
      platform: "instagram",
      format: "creator_reply",
      url: "https://www.instagram.com/p/example/",
    }),
    true,
  );
  assert.equal(
    isAuthoredComment({
      platform: "x",
      format: "text",
      text: "@creator cozy forever",
      url: "https://x.com/lofigirl/status/1",
    }),
    true,
  );
  assert.equal(
    isAuthoredComment({
      platform: "x",
      format: "text",
      text: "cozy forever",
      url: "https://x.com/lofigirl/status/2",
    }),
    false,
  );
});

test("derives a stable YouTube target and thumbnail without playing media", () => {
  const target = commentTarget({
    platform: "youtube",
    format: "comment",
    url: "https://www.youtube.com/watch?v=XNvfCrrGqGM&lc=comment-id",
    title: "Target video",
  });

  assert.equal(target.contentId, "XNvfCrrGqGM");
  assert.equal(target.url, "https://www.youtube.com/watch?v=XNvfCrrGqGM");
  assert.equal(
    target.thumbnailUrl,
    "https://i.ytimg.com/vi/XNvfCrrGqGM/hqdefault.jpg",
  );
  assert.equal(target.title, "Target video");
  assert.equal(target.confidence, "derived");
});

test("prefers verified parent metadata and keeps native audience precision", () => {
  const target = commentTarget({
    platform: "x",
    format: "comment",
    text: "@creator love this",
    url: "https://x.com/lofigirl/status/3",
    raw_json: JSON.stringify({
      commentTarget: {
        contentId: "2",
        url: "https://x.com/creator/status/2",
        title: "Parent post",
        thumbnailUrl: "https://pbs.twimg.com/media/example.jpg",
        authorHandle: "creator",
        authorName: "Creator",
        authorProfileUrl: "https://x.com/creator",
        audienceValue: 12345,
        audienceLabel: "12,3 k abonnés",
        audiencePrecision: "platform-rounded",
        audienceObservedAt: "2026-08-28T08:00:00.000Z",
        source: "fxtwitter-public-thread",
      },
    }),
  });

  assert.equal(target.contentId, "2");
  assert.equal(target.authorHandle, "creator");
  assert.equal(target.audienceValue, 12345);
  assert.equal(target.audienceLabel, "12,3 k abonnés");
  assert.equal(target.audiencePrecision, "platform-rounded");
  assert.equal(target.confidence, "verified");
});

test("never treats an unsafe target URL as clickable", () => {
  const target = commentTarget({
    platform: "tiktok",
    format: "comment",
    url: "https://www.tiktok.com/@creator/video/1",
    raw: {
      commentTarget: {
        url: "javascript:alert(1)",
        thumbnailUrl: "data:text/html,unsafe",
      },
    },
  });

  assert.equal(target.url, "https://www.tiktok.com/@creator/video/1");
  assert.equal(target.thumbnailUrl, null);
});

test("keeps internal target confidence labels out of comment cards", async () => {
  const component = await readFile(
    new URL("../app/AuthoredCommentsView.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(component, /Cible vérifiée|Cible dérivée/);
  assert.match(component, /platform: PlatformFilter/);
  assert.doesNotMatch(component, /authored-comment-platform-tabs|onPlatformChange|internalPlatform/);
});

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  authoredCommentCategory,
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

test("classifies Community, owned and external comment conversations", () => {
  assert.equal(
    authoredCommentCategory({
      platform: "youtube",
      format: "comment",
      url: "https://www.youtube.com/post/Ugkx-community?lc=comment-id",
    }),
    "community",
  );
  assert.equal(
    authoredCommentCategory({
      platform: "youtube",
      format: "comment",
      url: "https://www.youtube.com/watch?v=owned&lc=comment-id",
      raw: {
        commentTarget: {
          url: "https://www.youtube.com/watch?v=owned",
          authorHandle: "LofiGirl",
        },
      },
    }),
    "owned",
  );
  assert.equal(
    authoredCommentCategory({
      platform: "youtube",
      format: "comment",
      url: "https://www.youtube.com/watch?v=external&lc=comment-id",
      raw: {
        commentTarget: {
          url: "https://www.youtube.com/watch?v=external",
          authorHandle: "LofiGirlMusicFan",
        },
      },
    }),
    "external",
  );
  assert.equal(
    authoredCommentCategory({
      platform: "instagram",
      format: "comment",
      url: "https://www.instagram.com/p/example/c/1/",
      raw: {
        commentTarget: {
          url: "https://www.instagram.com/p/example/",
          authorProfileUrl: "https://example.com/lofigirl",
        },
      },
    }),
    "external",
  );
});

test("keeps internal target confidence labels out of comment cards", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/AuthoredCommentsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(component, /Cible vérifiée|Cible dérivée/);
  assert.match(component, /platform: PlatformFilter/);
  assert.doesNotMatch(component, /authored-comment-platform-tabs|onPlatformChange|internalPlatform/);
  assert.match(component, /useState<CommentCategoryFilter>\("external"\)/);
  assert.match(component, /\["external", "owned", "community"\] as const/);
  assert.equal((component.match(/<FilterDropdown/g) ?? []).length, 3);
  assert.match(component, /category-results-header category-results-toolbar/);
  assert.match(component, /category-results-adjacent-filters/);
  assert.match(component, /category-results-sort-filter/);
  assert.match(component, /label="Catégorie"/);
  assert.match(component, /Posts Communauté/);
  assert.match(component, /Nos vidéos/);
  assert.match(component, /Vidéos externes/);
  assert.match(component, /label="Date de publication"/);
  assert.match(component, /label="Trier"/);
  assert.doesNotMatch(component, /<span>Durée<\/span>/);
  assert.doesNotMatch(component, /<select|authored-comments-controls|authored-comment-filter-row/);
  assert.doesNotMatch(styles, /\.authored-comments-controls|\.authored-comment-filter-row/);
  assert.doesNotMatch(component, /Voir la conversation/);
  assert.doesNotMatch(component, /Compte commenté/);
  assert.match(component, /<small>Likes<\/small>/);
  assert.match(component, /<small>Réponses<\/small>/);
  assert.match(component, /year: "2-digit"/);

  const thumbnail = component.indexOf('className="authored-comment-thumbnail"');
  const body = component.indexOf('className="authored-comment-body"', thumbnail);
  const title = component.indexOf("<h3>{target.title}</h3>", body);
  const targetStrip = component.indexOf('className="authored-comment-target-strip"', title);
  const quote = component.indexOf("<blockquote>", body);
  const metrics = component.indexOf('className="authored-comment-metrics"', quote);
  const quoteEnd = component.indexOf("</blockquote>", metrics);
  assert.ok(thumbnail >= 0);
  assert.ok(body > thumbnail);
  assert.ok(title > body);
  assert.ok(targetStrip > title);
  assert.ok(quote > targetStrip);
  assert.ok(metrics > quote);
  assert.ok(quoteEnd > metrics);
});

test("serves Instagram comment thumbnails from the durable same-origin cache", async () => {
  const snapshot = JSON.parse(
    await readFile(new URL("../data/public-history.json", import.meta.url), "utf8"),
  );
  const comments = snapshot.posts.filter(
    (post) => post.platform === "instagram" && isAuthoredComment(post),
  );
  assert.ok(comments.length > 0);

  for (const post of comments) {
    const target = commentTarget(post);
    assert.equal(post.thumbnailUrl, target.thumbnailUrl);
    const thumbnail = new URL(target.thumbnailUrl);
    assert.equal(thumbnail.origin, "https://dim75017.github.io");
    const match = thumbnail.pathname.match(
      /^\/youtube-radar-kx9v2m\/social\/media\/instagram\/([A-Za-z0-9_-]+)\.jpg$/,
    );
    assert.ok(match, target.thumbnailUrl);
    const image = await stat(
      new URL(`../public/media/instagram/${match[1]}.jpg`, import.meta.url),
    );
    assert.ok(image.isFile());
    assert.ok(image.size > 1_000);
  }
});

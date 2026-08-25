/**
 * Public, append-only backfill for Lofi Girl's Instagram and X posts.
 *
 * It deliberately uses the public profile pages only. Values that those pages
 * do not expose stay null; the collector never substitutes a zero. Re-running
 * the job continues to enrich the same public-history snapshot.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  assertInstagramProfileListing,
  preserveCertifiedInstagramCoverage,
} from "./instagram-public-profile-guard.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = resolve(ROOT, "data/public-history.json");
const TARGET = process.env.SOCIAL_HISTORY_PLATFORM ?? "all";
const X_SCROLL_LIMIT = Number(process.env.X_SCROLL_LIMIT ?? 2200);
const INSTAGRAM_SCROLL_LIMIT = Number(process.env.INSTAGRAM_SCROLL_LIMIT ?? 420);
const INSTAGRAM_DETAILS_PER_RUN = Number(process.env.INSTAGRAM_DETAILS_PER_RUN ?? 420);
const INSTAGRAM_CONCURRENCY = 6;

function asCount(value) {
  if (typeof value !== "string") return null;
  const match = value.replace(/\s/g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)([kKmMbB]?)/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[match[2].toLowerCase()] ?? 1;
  return Math.round(number * multiplier);
}

function textTitle(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function publicPost({ platform, externalId, url, text = "", format, thumbnailUrl = null, publishedAt = null, views = null, likes = null, comments = null, shares = null, raw = {} }) {
  return {
    platform,
    externalId,
    url,
    title: textTitle(text),
    text,
    format,
    thumbnailUrl,
    publishedAt,
    views,
    likes,
    comments,
    shares,
    saves: null,
    raw: {
      collector: "public-profile-pagination",
      firstObservedAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      metricHistory: [],
      ...raw,
    },
  };
}

function mergePost(current, incoming) {
  if (!current) return incoming;
  const merged = { ...current, ...incoming, raw: { ...(current.raw ?? {}), ...(incoming.raw ?? {}) } };
  for (const key of ["title", "text", "thumbnailUrl", "publishedAt", "views", "likes", "comments", "shares", "saves"]) {
    const before = current[key];
    const next = incoming[key];
    if (before != null && (next == null || (typeof before === "string" && before.length > String(next).length))) merged[key] = before;
  }
  merged.raw.firstObservedAt = current.raw?.firstObservedAt ?? incoming.raw?.firstObservedAt;
  merged.raw.lastObservedAt = new Date().toISOString();
  return merged;
}

async function collectX(page) {
  await page.goto("https://x.com/lofigirl", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const found = new Map();
  let stagnant = 0;
  for (let turn = 0; turn < X_SCROLL_LIMIT && stagnant < 18; turn += 1) {
    const batch = await page.locator("article").evaluateAll((articles) => articles.map((article) => {
      const status = [...article.querySelectorAll("a[href*='/status/']")]
        .map((link) => link.getAttribute("href") ?? "")
        .find((href) => /\/lofigirl\/status\/\d+/.test(href));
      if (!status) return null;
      const id = status.match(/status\/(\d+)/)?.[1];
      if (!id) return null;
      const buttonCount = (testId) => {
        const value = article.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
        return value || null;
      };
      const media = article.querySelector("img[src*='pbs.twimg.com/media']")?.getAttribute("src") ?? null;
      const hasVideo = Boolean(article.querySelector("video, [data-testid='videoPlayer']"));
      return {
        id,
        text: article.querySelector("[data-testid='tweetText']")?.textContent ?? "",
        publishedAt: article.querySelector("time")?.getAttribute("datetime") ?? null,
        replies: buttonCount("reply"),
        likes: buttonCount("like"),
        views: buttonCount("analytics"),
        reposts: buttonCount("retweet"),
        thumbnailUrl: media,
        format: hasVideo ? "video" : media ? "image" : "text",
      };
    }).filter(Boolean));
    let added = 0;
    for (const item of batch) {
      if (found.has(item.id)) continue;
      found.set(item.id, publicPost({
        platform: "x",
        externalId: item.id,
        url: `https://x.com/lofigirl/status/${item.id}`,
        text: item.text,
        format: item.format,
        thumbnailUrl: item.thumbnailUrl,
        publishedAt: item.publishedAt,
        views: asCount(item.views),
        likes: asCount(item.likes),
        comments: asCount(item.replies),
        shares: asCount(item.reposts),
        raw: { source: "x-public-profile", collectorVersion: "backfill-v1" },
      }));
      added += 1;
    }
    stagnant = added ? 0 : stagnant + 1;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 2, 1500)));
    await page.waitForTimeout(700);
  }
  return [...found.values()];
}

async function instagramLinks(page) {
  await page.goto("https://www.instagram.com/lofigirl/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const links = new Map();
  let stagnant = 0;
  for (let turn = 0; turn < INSTAGRAM_SCROLL_LIMIT && stagnant < 14; turn += 1) {
    const batch = await page.locator("a[href*='/p/'], a[href*='/reel/']").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean));
    let added = 0;
    for (const href of batch) {
      const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
      if (!match || links.has(match[2])) continue;
      links.set(match[2], { kind: match[1], url: `https://www.instagram.com/${match[1]}/${match[2]}/` });
      added += 1;
    }
    stagnant = added ? 0 : stagnant + 1;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 2, 1500)));
    await page.waitForTimeout(700);
  }
  return [...links.entries()].map(([id, value]) => ({ id, ...value }));
}

async function collectInstagram(context, existing) {
  const profile = await context.newPage();
  const links = await instagramLinks(profile);
  await profile.close();
  const pending = links.filter((link) => !existing.has(`instagram:${link.id}`)).slice(0, INSTAGRAM_DETAILS_PER_RUN);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    const page = await context.newPage();
    try {
      while (cursor < pending.length) {
        const link = pending[cursor++];
        try {
          await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          const detail = await page.locator("head").evaluate((head) => {
            const meta = (selector) => head.querySelector(selector)?.getAttribute("content") ?? null;
            const description = meta("meta[property='og:description']") ?? meta("meta[name='description']") ?? "";
            const image = meta("meta[property='og:image']");
            const title = meta("meta[property='og:title']") ?? "";
            return { description, image, title };
          });
          const likes = asCount(detail.description.match(/([\d.,]+\s*[kKmM]?)\s+likes/i)?.[1] ?? null);
          const comments = asCount(detail.description.match(/([\d.,]+\s*[kKmM]?)\s+comments/i)?.[1] ?? null);
          results.push(publicPost({
            platform: "instagram",
            externalId: link.id,
            url: link.url,
            text: detail.title.replace(/\s*\(@?lofigirl\).*$/i, "") || detail.description,
            format: link.kind === "reel" ? "reel" : "static",
            thumbnailUrl: detail.image,
            likes,
            comments,
            raw: { source: "instagram-public-profile", collectorVersion: "backfill-v1" },
          }));
        } catch {
          // A temporarily unavailable public post stays eligible at the next run.
        }
      }
    } finally {
      await page.close();
    }
  };
  await Promise.all(Array.from({ length: INSTAGRAM_CONCURRENCY }, worker));
  return { listed: links.length, posts: results, pending: pending.length };
}

function replaceCoverage(snapshot, platform, itemCount, scope, limitations) {
  const previousCoverage = Array.isArray(snapshot.coverage)
    ? snapshot.coverage.find((item) => item?.platform === platform)
    : null;
  const coverage = Array.isArray(snapshot.coverage) ? snapshot.coverage.filter((item) => item?.platform !== platform) : [];
  const platformPosts = snapshot.posts.filter((post) => post.platform === platform && post.publishedAt);
  const dates = platformPosts.map((post) => post.publishedAt).sort();
  let nextCoverage = { platform, accountUrl: platform === "x" ? "https://x.com/lofigirl" : "https://www.instagram.com/lofigirl/", scope, status: "partial-public-profile", itemCount, oldestPublishedAt: dates[0] ?? null, newestPublishedAt: dates.at(-1) ?? null, limitations };
  if (platform === "instagram") {
    nextCoverage = preserveCertifiedInstagramCoverage(previousCoverage, nextCoverage);
  }
  coverage.push(nextCoverage);
  snapshot.coverage = coverage;
}

const snapshot = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
snapshot.posts ??= [];
const byKey = new Map(snapshot.posts.map((post) => [`${post.platform}:${post.externalId}`, post]));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1365, height: 900 } });

try {
  if (TARGET === "all" || TARGET === "x") {
    const page = await context.newPage();
    const xPosts = await collectX(page);
    await page.close();
    for (const post of xPosts) byKey.set(`x:${post.externalId}`, mergePost(byKey.get(`x:${post.externalId}`), post));
    snapshot.posts = [...byKey.values()];
    replaceCoverage(snapshot, "x", snapshot.posts.filter((post) => post.platform === "x").length, "historique public du profil", ["Le scan défile le profil public jusqu’au dernier lot disponible. Les contenus supprimés, privés ou retenus par X restent naturellement hors de portée."]);
  }
  if (TARGET === "all" || TARGET === "instagram") {
    const instagram = await collectInstagram(context, byKey);
    assertInstagramProfileListing({ listed: instagram.listed, snapshot });
    for (const post of instagram.posts) byKey.set(`instagram:${post.externalId}`, mergePost(byKey.get(`instagram:${post.externalId}`), post));
    snapshot.posts = [...byKey.values()];
    replaceCoverage(snapshot, "instagram", snapshot.posts.filter((post) => post.platform === "instagram").length, "historique public du profil", [instagram.pending < instagram.listed ? `Backfill progressif : ${instagram.pending}/${instagram.listed} fiches accessibles dans ce lot.` : "Le profil public n’a pas exposé de publication supplémentaire dans ce lot."]);
  }
  snapshot.posts.sort((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? "")) || `${left.platform}:${left.externalId}`.localeCompare(`${right.platform}:${right.externalId}`));
  snapshot.generatedAt = new Date().toISOString();
  await writeFile(HISTORY_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ platform: TARGET, totals: snapshot.posts.reduce((all, post) => ({ ...all, [post.platform]: (all[post.platform] ?? 0) + 1 }), {}) }));
} finally {
  await context.close();
  await browser.close();
}

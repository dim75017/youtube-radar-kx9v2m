import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIVITY_URL = "https://www.instagram.com/your_activity/interactions/comments/";
const DEFAULT_HISTORY = resolve("data", "public-history.json");
const DEFAULT_PROFILE = resolve("work", "owner-comments", "browser-profiles", "instagram");
const DEDICATED_PROFILE_ROOT = resolve("work", "owner-comments", "browser-profiles");
const DEFAULT_OUTPUT = resolve(
  "work",
  "owner-comments",
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
  "instagram",
  "headless-metrics.checkpoint.json",
);

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeVisibleText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function parseInstagramCount(value) {
  const text = normalizeVisibleText(value)
    .replace(/\u202f|\u00a0/gu, " ")
    .replace(/\s+/gu, " ");
  const match = text.match(/(?:^|\s)(\d[\d., ]*)\s*([kmb])?(?:\s|$)/iu);
  if (!match) return null;
  const suffix = match[2]?.toLowerCase() ?? null;
  const compact = match[1].replace(/\s+/gu, "");
  let numericText = compact;
  if (suffix) {
    const lastSeparator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
    if (lastSeparator >= 0) {
      const integerPart = compact.slice(0, lastSeparator).replace(/[.,]/gu, "");
      const decimalPart = compact.slice(lastSeparator + 1);
      if (!/^\d+$/u.test(integerPart) || !/^\d{1,2}$/u.test(decimalPart)) return null;
      numericText = `${integerPart}.${decimalPart}`;
    }
  } else if (/[.,]/u.test(compact)) {
    const groups = compact.split(/[.,]/u);
    if (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some((group) => !/^\d{3}$/u.test(group))) {
      return null;
    }
    numericText = groups.join("");
  }
  const numeric = Number(numericText);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix] ?? 1;
  return Math.round(numeric * multiplier);
}

export function parseInstagramMetricLabels(labels) {
  const values = Array.isArray(labels) ? labels.map(normalizeVisibleText).filter(Boolean) : [];
  const metric = (pattern) => {
    const parsed = values
      .filter((value) => pattern.test(value))
      .map(parseInstagramCount)
      .filter((value) => value != null);
    const distinct = [...new Set(parsed)];
    return {
      value: distinct.length === 1 ? distinct[0] : null,
      ambiguous: distinct.length > 1,
    };
  };
  const likes = metric(/\blikes?\b/iu);
  const replies = metric(/\brepl(?:y|ies)\b/iu);
  return {
    likes: likes.value,
    replies: replies.value,
    ambiguousLikes: likes.ambiguous,
    ambiguousReplies: replies.ambiguous,
  };
}

export function instagramAccessState({ url, text }) {
  const normalizedUrl = String(url ?? "").toLowerCase();
  const normalizedText = normalizeVisibleText(text).toLowerCase();
  if (
    normalizedUrl.includes("/challenge/") ||
    normalizedUrl.includes("/checkpoint/") ||
    /confirm it'?s you|challenge required|suspicious login|help us confirm/iu.test(normalizedText)
  ) {
    return "challenge";
  }
  if (
    normalizedUrl.includes("/accounts/login") ||
    /log in to instagram|sign up to see photos/iu.test(normalizedText)
  ) {
    return "unauthenticated";
  }
  if (/please wait a few minutes|try again later|too many requests/iu.test(normalizedText)) {
    return "rate-limited";
  }
  return "ready";
}

export function assertDedicatedInstagramProfilePath(value) {
  const profile = resolve(value);
  const child = relative(DEDICATED_PROFILE_ROOT, profile);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Le profil doit rester sous work/owner-comments/browser-profiles/.");
  }
  return profile;
}

function instagramContentUrl(post) {
  for (const value of [post?.raw?.commentTarget?.url, post?.url]) {
    const candidate = nullableString(value);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (!/(^|\.)instagram\.com$/iu.test(url.hostname)) continue;
      const match = url.pathname.match(/^\/(?:[^/?#]+\/)?(p|reel|tv)\/([^/?#]+)\/?$/iu);
      if (!match) continue;
      return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
    } catch {
      // Ignore malformed historical URLs and leave the row out of this collector.
    }
  }
  return null;
}

function commentSuffix(post) {
  const externalId = nullableString(post?.externalId);
  return externalId?.startsWith("comment:") ? externalId.slice("comment:".length) : null;
}

function instagramNavigationUrl(value, fallback) {
  const candidate = nullableString(value);
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    if (!/(^|\.)instagram\.com$/iu.test(url.hostname)) return fallback;
    const match = url.pathname.match(
      /^\/(?:[^/?#]+\/)?(p|reel|tv)\/([^/?#]+)(?:\/c\/(\d{10,30}))?\/?$/iu,
    );
    if (!match) return fallback;
    const commentPath = match[3] ? `c/${match[3]}/` : "";
    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/${commentPath}`;
  } catch {
    return fallback;
  }
}

function nativeDeepCommentUrl(value, id) {
  const candidate = instagramNavigationUrl(value, null);
  if (!candidate || !/^\d{10,30}$/u.test(id)) return null;
  const url = new URL(candidate);
  const match = url.pathname.match(/^\/(?:p|reel|tv)\/[^/?#]+\/c\/(\d{10,30})\/?$/iu);
  return match?.[1] === id ? candidate : null;
}

export function buildInstagramMetricQueue(snapshot, limit = Number.POSITIVE_INFINITY) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.posts)) {
    throw new Error("public-history.json doit contenir posts[].");
  }
  const queue = [];
  for (const post of snapshot.posts) {
    if (post?.platform !== "instagram" || post?.format !== "comment") continue;
    const id = commentSuffix(post);
    const contentUrl = instagramContentUrl(post);
    const text = nullableString(post.text);
    const idKind = post.raw?.commentIdKind === "native" ? "native" : "synthetic";
    const deepCommentUrl = idKind === "native" ? nativeDeepCommentUrl(post.url, id) : null;
    const commentUrl = deepCommentUrl ?? contentUrl;
    if (!id || !contentUrl || !commentUrl || !text) continue;
    queue.push({
      id,
      idKind,
      contentUrl,
      commentUrl,
      isNativeDeepLink: deepCommentUrl != null,
      text,
      existing: post,
    });
    if (queue.length >= limit) break;
  }
  return queue;
}

function targetFromExisting(post, contentUrl) {
  const target = isRecord(post?.raw?.commentTarget) ? post.raw.commentTarget : {};
  return {
    contentId: nullableString(target.contentId),
    url: contentUrl,
    status: "available",
    unavailable: false,
    title: nullableString(target.title) ?? nullableString(post.title) ?? "Contenu Instagram commenté",
    thumbnailUrl: nullableString(target.thumbnailUrl) ?? nullableString(post.thumbnailUrl),
    authorHandle: nullableString(target.authorHandle),
    authorName: nullableString(target.authorName),
    authorProfileUrl: nullableString(target.authorProfileUrl),
    audienceValue: Number.isSafeInteger(target.audienceValue) ? target.audienceValue : null,
    audienceLabel: nullableString(target.audienceLabel),
    audiencePrecision: nullableString(target.audiencePrecision) ?? "unknown",
    audienceObservedAt: nullableString(target.audienceObservedAt),
  };
}

export function buildInstagramImportRow(candidate, observation, capturedAt) {
  const previousObservation = isRecord(candidate.existing?.raw?.commentObservation)
    ? candidate.existing.raw.commentObservation
    : {};
  const exactPublishedAt = nullableString(observation.publishedAt);
  return {
    id: candidate.id,
    idKind: candidate.idKind,
    url: candidate.commentUrl,
    text: candidate.text,
    publishedAt: exactPublishedAt ?? nullableString(candidate.existing.publishedAt),
    publishedAtPrecision: exactPublishedAt
      ? "exact"
      : nullableString(candidate.existing?.raw?.publishedAtPrecision) ?? "unknown",
    target: targetFromExisting(candidate.existing, candidate.contentUrl),
    metrics: {
      likes: observation.metrics.likes,
      replies: observation.metrics.replies,
    },
    observation: {
      relativeAge: nullableString(previousObservation.relativeAge),
      observedAt: capturedAt,
      stableSyntheticId: nullableString(previousObservation.stableSyntheticId),
    },
  };
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function parseOptions(argv) {
  const options = {
    history: DEFAULT_HISTORY,
    profile: DEFAULT_PROFILE,
    output: DEFAULT_OUTPUT,
    limit: Number.POSITIVE_INFINITY,
    delayMs: 1_250,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--history") options.history = argv[++index];
    else if (argument === "--profile") options.profile = assertDedicatedInstagramProfilePath(argv[++index]);
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--delay-ms") options.delayMs = Number(argv[++index]);
    else throw new Error(`Option inconnue : ${argument}`);
  }
  if (!Number.isInteger(options.limit) && options.limit !== Number.POSITIVE_INFINITY) {
    throw new Error("--limit doit être un entier positif.");
  }
  if (options.limit <= 0 || !Number.isFinite(options.delayMs) || options.delayMs < 750) {
    throw new Error("--limit doit être positif et --delay-ms supérieur ou égal à 750.");
  }
  options.profile = assertDedicatedInstagramProfilePath(options.profile);
  return options;
}

async function playwrightModule() {
  const bundledEntry = resolve(
    dirname(process.execPath),
    "..",
    "node_modules",
    "playwright",
    "index.mjs",
  );
  const candidates = ["playwright"];
  if (await access(bundledEntry).then(() => true).catch(() => false)) {
    candidates.push(pathToFileURL(bundledEntry).href);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "Playwright est absent. Installer ponctuellement `npm install --no-save playwright`.",
    { cause: lastError },
  );
}

async function visibleBodyText(page) {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

async function passiveAccessState(page) {
  const state = instagramAccessState({ url: page.url(), text: await visibleBodyText(page) });
  if (["challenge", "rate-limited"].includes(state)) {
    throw new Error(`Collecte Instagram interrompue : ${state}.`);
  }
  return state;
}

async function observeKnownComment(page, candidate) {
  await page.goto(candidate.commentUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  const accessState = await passiveAccessState(page);
  const raw = await page.evaluate(({ expectedId, expectedText, expectedContentPath, requireDeepId }) => {
    const pageDocument = globalThis.document;
    const pageLocation = globalThis.location;
    const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const currentContentPath = pageLocation.pathname
      .match(/^\/(?:p|reel|tv)\/[^/?#]+/iu)?.[0]
      ?.replace(/\/+$/u, "");
    const idMatch = pageLocation.pathname.match(/\/c\/(\d{10,30})\/?$/iu);
    if (currentContentPath !== expectedContentPath || (requireDeepId && idMatch?.[1] !== expectedId)) {
      return { matchCount: 0, rejectedCount: 0, candidates: [] };
    }
    const expected = normalize(expectedText);
    const leaves = [...pageDocument.querySelectorAll("span, div")].filter((element) => {
      const ownText = normalize(element.textContent);
      if (ownText !== expected) return false;
      return ![...element.children].some((child) => normalize(child.textContent) === expected);
    });
    const containers = [...new Set(
      leaves.map((leaf) => leaf.closest("li, [role='listitem']")).filter(Boolean),
    )];
    const candidates = containers.map((container) => {
      const exactTextCount = leaves.filter((leaf) => container.contains(leaf)).length;
      const times = [...container.querySelectorAll("time[datetime]")];
      const exactAuthorLinks = [...container.querySelectorAll("a[href]")].filter((anchor) => {
        try {
          return new URL(anchor.getAttribute("href"), pageLocation.origin).pathname
            .replace(/\/+$/u, "")
            .toLowerCase() === "/lofigirl";
        } catch {
          return false;
        }
      });
      const labels = [...container.querySelectorAll("button, a, span")]
        .map((element) => normalize(element.getAttribute("aria-label") || element.textContent))
        .filter((value) => /\blikes?\b|\brepl(?:y|ies)\b/iu.test(value));
      return {
        valid: exactTextCount === 1 && times.length === 1 && exactAuthorLinks.length >= 1,
        publishedAt: times.length === 1 ? times[0].getAttribute("datetime") : null,
        labels: [...new Set(labels)],
      };
    });
    const validCandidates = candidates.filter((item) => item.valid);
    return {
      matchCount: validCandidates.length,
      rejectedCount: candidates.length - validCandidates.length,
      candidates: validCandidates,
    };
  }, {
    expectedId: candidate.id,
    expectedText: candidate.text,
    expectedContentPath: new URL(candidate.contentUrl).pathname.replace(/\/+$/u, ""),
    requireDeepId: candidate.isNativeDeepLink,
  });
  if (raw.matchCount !== 1) {
    return {
      status: raw.matchCount === 0 ? "not-found" : "ambiguous",
      accessState,
      publishedAt: null,
      metrics: { likes: null, replies: null },
      evidence: { matchCount: raw.matchCount, rejectedCount: raw.rejectedCount },
    };
  }
  const found = raw.candidates[0];
  const metrics = parseInstagramMetricLabels(found.labels);
  if (metrics.ambiguousLikes || metrics.ambiguousReplies) {
    return {
      status: "ambiguous-metrics",
      accessState,
      publishedAt: null,
      metrics: { likes: null, replies: null },
      evidence: { matchCount: 1, rejectedCount: raw.rejectedCount, labels: found.labels },
    };
  }
  return {
    status: "observed",
    accessState,
    publishedAt:
      found.publishedAt && Number.isFinite(Date.parse(found.publishedAt))
        ? new Date(found.publishedAt).toISOString()
        : null,
    metrics: { likes: metrics.likes, replies: metrics.replies },
    evidence: { matchCount: 1, rejectedCount: raw.rejectedCount, labels: found.labels },
  };
}

async function collect(options) {
  const capturedAt = new Date().toISOString();
  const snapshot = JSON.parse(await readFile(resolve(options.history), "utf8"));
  const allQueue = buildInstagramMetricQueue(snapshot);
  const queue = allQueue.slice(0, options.limit);
  const sourceCommentCount = snapshot.posts.filter(
    (post) => post?.platform === "instagram" && post?.format === "comment",
  ).length;
  const checkpoint = {
    platform: "instagram",
    capturedAt,
    activitySourceUrl: ACTIVITY_URL,
    inventory: {
      inventoryStatus: "partial",
      endReached: false,
      recordCount: 0,
    },
    collection: {
      mode: "isolated-headless-known-target-enrichment",
      profileDirectory: "private-ignored-work-directory",
      sourceCommentCount,
      eligibleKnownTargetCount: allQueue.length,
      eligibleDeepLinkCount: allQueue.filter((candidate) => candidate.isNativeDeepLink).length,
      unresolvedTargetCount: sourceCommentCount - allQueue.length,
      deferredCount: allQueue.length - queue.length,
      queueCount: queue.length,
      attemptedCount: 0,
      observedCount: 0,
      metricCount: 0,
      unauthenticatedAttemptCount: 0,
      stoppedReason: null,
      attempts: [],
    },
    comments: [],
  };
  await writeJsonAtomically(resolve(options.output), checkpoint);
  let chromium;
  try {
    ({ chromium } = await playwrightModule());
  } catch (error) {
    checkpoint.collection.stoppedReason = "playwright-unavailable";
    await writeJsonAtomically(resolve(options.output), checkpoint);
    throw error;
  }
  let context;
  try {
    context = await chromium.launchPersistentContext(resolve(options.profile), {
      headless: true,
      channel: "chrome",
      locale: "en-US",
      timezoneId: "Europe/Paris",
      viewport: { width: 1_440, height: 1_200 },
      args: ["--autoplay-policy=user-gesture-required", "--mute-audio"],
    });
  } catch (error) {
    checkpoint.collection.stoppedReason = "isolated-profile-unavailable";
    await writeJsonAtomically(resolve(options.output), checkpoint);
    throw error;
  }
  await context.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (["media", "font"].includes(type)) await route.abort();
    else await route.continue();
  });
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  try {
    for (const candidate of queue) {
      let observation;
      try {
        observation = await observeKnownComment(page, candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/challenge|rate-limited/iu.test(message)) {
          checkpoint.collection.stoppedReason = message;
          await writeJsonAtomically(resolve(options.output), checkpoint);
          throw error;
        }
        observation = {
          status: "failed",
          accessState: null,
          publishedAt: null,
          metrics: { likes: null, replies: null },
          evidence: { error: message },
        };
      }
      checkpoint.collection.attemptedCount += 1;
      if (observation.accessState === "unauthenticated") {
        checkpoint.collection.unauthenticatedAttemptCount += 1;
      }
      checkpoint.collection.attempts.push({
        externalId: `comment:${candidate.id}`,
        url: candidate.commentUrl,
        status: observation.status,
        accessState: observation.accessState,
        publishedAt: observation.publishedAt,
        likes: observation.metrics.likes,
        replies: observation.metrics.replies,
      });
      if (observation.status === "observed") {
        checkpoint.collection.observedCount += 1;
        if (observation.metrics.likes != null || observation.metrics.replies != null) {
          checkpoint.collection.metricCount += 1;
        }
        checkpoint.comments.push(buildInstagramImportRow(candidate, observation, capturedAt));
        checkpoint.inventory.recordCount = checkpoint.comments.length;
      }
      await writeJsonAtomically(resolve(options.output), checkpoint);
      await page.waitForTimeout(options.delayMs);
    }
    if (
      checkpoint.collection.attemptedCount > 0 &&
      checkpoint.collection.unauthenticatedAttemptCount === checkpoint.collection.attemptedCount &&
      checkpoint.collection.observedCount === 0
    ) {
      checkpoint.collection.stoppedReason = "unauthenticated-targets-unavailable";
      await writeJsonAtomically(resolve(options.output), checkpoint);
    }
    return checkpoint;
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await collect(options);
  process.stdout.write(`${JSON.stringify({
    output: resolve(options.output),
    queueCount: result.collection.queueCount,
    attemptedCount: result.collection.attemptedCount,
    observedCount: result.collection.observedCount,
    metricCount: result.collection.metricCount,
  }, null, 2)}\n`);
  if (result.collection.stoppedReason) process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

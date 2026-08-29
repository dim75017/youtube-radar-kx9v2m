import { readFile, rename, writeFile } from "node:fs/promises";
import { collectYoutubeApiMetrics } from "./youtube_comment_metrics_api.mjs";

const root = new URL("../", import.meta.url);
const queuePath = new URL("data/youtube-comment-metric-queue.json", root);
const outputPath = new URL("data/youtube-comment-metrics.json", root);
const queue = JSON.parse(await readFile(queuePath, "utf8")).comments ?? [];
const refreshAfterMs = Number(process.env.YOUTUBE_COMMENT_REFRESH_AFTER_MS ?? 23 * 60 * 60 * 1_000);
const requestedIds = new Set(
  String(process.env.YOUTUBE_COMMENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const forceRefresh = process.env.YOUTUBE_COMMENT_FORCE_REFRESH === "1";
const youtubeApiKey = String(process.env.YOUTUBE_API_KEY ?? "").trim();

let state;
try {
  state = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  state = { schema: 1, total: queue.length, updatedAt: null, results: {}, failures: {} };
}

function parseCount(label) {
  const match = String(label ?? "")
    .replace(/[\u00a0\u202f]/g, " ")
    .match(/([\d\s.,]+)\s*([kKmM])?\s*(?:autre|personne|personnes|réponse|réponses)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/\s/g, "").replace(",", "."));
  const unit = match[2]?.toLowerCase();
  return Number.isFinite(value) ? Math.round(value * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1)) : null;
}

async function persist() {
  state.total = queue.length;
  state.updatedAt = new Date().toISOString();
  const temporary = new URL("data/youtube-comment-metrics.tmp.json", root);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, outputPath);
}

async function readMetric(page, entry) {
  await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.scrollTo(0, 1_200));
  await page.waitForTimeout(2_000);

  const read = () => page.evaluate((id) => {
    const anchor = [...document.querySelectorAll('a[href*="lc="]')].find((node) => {
      try { return new URL(node.href).searchParams.get("lc") === id; } catch { return false; }
    });
    if (!anchor) return null;
    const comment = anchor.closest("ytd-comment-view-model, ytd-comment-renderer");
    const thread = anchor.closest("ytd-comment-thread-renderer");
    const labels = [...(comment?.querySelectorAll("button") ?? [])]
      .map((node) => node.getAttribute("aria-label") || node.innerText)
      .filter(Boolean);
    return {
      likesLabel: labels.find((label) => /aime (?:ce commentaire|cette réponse)|aiment (?:ce commentaire|cette réponse)/i.test(label)) ?? null,
      repliesLabel: [...(thread?.querySelectorAll("button") ?? [])]
        .map((node) => node.getAttribute("aria-label") || node.innerText)
        .find((label) => /^\s*[\d\s.,]+\s*(?:k\s*)?réponses?\s*$/i.test(label)) ?? null,
    };
  }, entry.id);

  let metric = await read();
  if (!metric) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await page.waitForTimeout(1_500);
    metric = await read();
  }
  if (!metric) return null;
  return {
    likes: parseCount(metric.likesLabel),
    replies: entry.id.includes(".") ? 0 : parseCount(metric.repliesLabel),
  };
}

const now = Date.now();
const pending = queue.filter((entry) => {
  if (requestedIds.size && !requestedIds.has(entry.id)) return false;
  if (forceRefresh) return true;
  const capturedAt = Date.parse(state.results[entry.id]?.capturedAt ?? "");
  return !Number.isFinite(capturedAt) || now - capturedAt >= refreshAfterMs;
});
if (!pending.length) {
  console.log("No stale YouTube comment metric requires collection.");
  process.exit(0);
}

let domPending = pending;
if (youtubeApiKey) {
  const apiOutcome = await collectYoutubeApiMetrics(pending, { apiKey: youtubeApiKey });
  const capturedAt = new Date().toISOString();
  for (const [id, metric] of apiOutcome.resolved) {
    state.results[id] = { ...metric, capturedAt, source: "youtube-data-api-v3" };
    delete state.failures[id];
  }
  domPending = apiOutcome.unresolved;
  if (apiOutcome.errors.length) {
    console.warn(`${apiOutcome.errors.length} lot(s) API YouTube restent à vérifier via le DOM.`);
  }
  if (apiOutcome.resolved.size) await persist();
  if (!domPending.length) {
    console.log(`Collected ${apiOutcome.resolved.size} YouTube comment metrics via Data API v3.`);
    process.exit(0);
  }
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_URL ?? "playwright");

const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
const pageCount = Math.min(6, domPending.length);
const pages = await Promise.all(Array.from({ length: pageCount }, () => browser.newPage({ locale: "fr-FR" })));
await Promise.all(pages.map((page) => page.route("**/*", (route) =>
  route.request().resourceType() === "media" ? route.abort() : route.continue(),
)));

for (let offset = 0; offset < domPending.length; offset += pages.length) {
  const batch = domPending.slice(offset, offset + pages.length);
  const outcomes = await Promise.all(batch.map(async (entry, index) => {
    try { return { entry, metric: await readMetric(pages[index], entry) }; }
    catch (error) { return { entry, metric: null, error: String(error).slice(0, 180) }; }
  }));

  for (const { entry, metric, error } of outcomes) {
    const hasObservedMetric = metric && (Number.isInteger(metric.likes) || Number.isInteger(metric.replies));
    if (hasObservedMetric) {
      state.results[entry.id] = { ...metric, capturedAt: new Date().toISOString(), source: "youtube-direct-comment" };
      delete state.failures[entry.id];
    } else {
      const attempts = (state.failures[entry.id]?.attempts ?? 0) + 1;
      state.failures[entry.id] = { attempts, lastError: error ?? "not-found", attemptedAt: new Date().toISOString() };
    }
  }
  if ((offset / pages.length) % 10 === 0) await persist();
}

await persist();
await browser.close();

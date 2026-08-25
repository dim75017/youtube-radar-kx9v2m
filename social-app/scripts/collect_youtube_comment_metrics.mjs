import { readFile, rename, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const queuePath = new URL("data/youtube-comment-metric-queue.json", root);
const outputPath = new URL("data/youtube-comment-metrics.json", root);
const queue = JSON.parse(await readFile(queuePath, "utf8")).comments ?? [];

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
    likes: parseCount(metric.likesLabel) ?? 0,
    replies: entry.id.includes(".") ? 0 : parseCount(metric.repliesLabel) ?? 0,
  };
}

const browser = await chromium.launch({ headless: true });
const pages = await Promise.all(Array.from({ length: 6 }, () => browser.newPage({ locale: "fr-FR" })));
const pending = queue.filter((entry) => !state.results[entry.id]);

for (let offset = 0; offset < pending.length; offset += pages.length) {
  const batch = pending.slice(offset, offset + pages.length);
  const outcomes = await Promise.all(batch.map(async (entry, index) => {
    try { return { entry, metric: await readMetric(pages[index], entry) }; }
    catch (error) { return { entry, metric: null, error: String(error).slice(0, 180) }; }
  }));

  for (const { entry, metric, error } of outcomes) {
    if (metric) {
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

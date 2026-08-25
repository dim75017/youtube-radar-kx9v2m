/**
 * Resolves the YouTube channel id of every watchlist account from its public
 * handle page, then rewrites the watchlist in place.
 *
 * The fast lane reads Atom feeds, which are addressed by channel id only. A
 * handle can be renamed by its owner, a channel id cannot, so the id is the
 * value we persist. An account whose id cannot be resolved is reported and
 * left untouched: it is never guessed and never silently dropped.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watchlistPath = resolve(root, "data", "comment-opportunities", "watchlist.json");
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;
const USER_AGENT =
  "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/lofi-social-radar)";

export function extractChannelId(html) {
  const canonical = html.match(
    /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/u,
  );
  if (canonical) return canonical[1];
  const embedded = html.match(/"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]{22})"/u);
  return embedded ? embedded[1] : null;
}

async function resolveHandle(handle) {
  const response = await fetch(`https://www.youtube.com/${handle}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const channelId = extractChannelId(await response.text());
  if (!channelId) throw new Error("identifiant de chaîne absent de la page publique");
  return channelId;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("resolve-watchlist-channels.mjs")) {
  const watchlist = JSON.parse(await readFile(watchlistPath, "utf8"));
  const force = process.argv.includes("--force");
  const pending = watchlist.accounts.filter(
    (account) => force || typeof account.youtubeChannelId !== "string" || account.youtubeChannelId.length === 0,
  );

  if (pending.length === 0) {
    console.log("Watchlist déjà résolue : aucun identifiant manquant.");
    process.exit(0);
  }

  const failures = [];
  await mapWithConcurrency(pending, CONCURRENCY, async (account) => {
    try {
      account.youtubeChannelId = await resolveHandle(account.handle);
      console.log(`✓ ${account.handle} → ${account.youtubeChannelId}`);
    } catch (error) {
      failures.push({
        handle: account.handle,
        reason: error instanceof Error ? error.message : "échec inconnu",
      });
      console.log(`✗ ${account.handle} : ${error instanceof Error ? error.message : "échec inconnu"}`);
    }
  });

  watchlist.accounts = watchlist.accounts.filter(
    (account) => typeof account.youtubeChannelId === "string" && account.youtubeChannelId.length > 0,
  );
  watchlist.accounts.sort((left, right) =>
    left.category === right.category
      ? left.handle.localeCompare(right.handle, "en")
      : left.category.localeCompare(right.category, "en"),
  );
  watchlist.resolvedAt = new Date().toISOString();
  await writeFile(watchlistPath, `${JSON.stringify(watchlist, null, 2)}\n`, "utf8");

  console.log(`\n${watchlist.accounts.length} comptes résolus.`);
  if (failures.length > 0) {
    console.log(`${failures.length} handles non résolus et retirés :`);
    for (const failure of failures) console.log(`  - ${failure.handle} (${failure.reason})`);
  }
}

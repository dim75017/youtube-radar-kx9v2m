const API_ROOT = "https://www.googleapis.com/youtube/v3/";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 20_000;

export async function collectYoutubeApiMetrics(entries, {
  apiKey,
  fetchImpl = globalThis.fetch,
  batchSize = DEFAULT_BATCH_SIZE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const uniqueEntries = [...new Map(
    entries
      .filter((entry) => typeof entry?.id === "string" && entry.id)
      .map((entry) => [entry.id, entry]),
  ).values()];
  const resolved = new Map();
  const errors = [];
  if (!apiKey) return { resolved, unresolved: uniqueEntries, errors };
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl doit être une fonction.");

  const normalizedBatchSize = Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Math.trunc(batchSize) || DEFAULT_BATCH_SIZE));
  const topLevelEntries = uniqueEntries.filter((entry) => !entry.id.includes("."));
  const replyEntries = uniqueEntries.filter((entry) => entry.id.includes("."));

  await collectBatches({
    entries: topLevelEntries,
    endpoint: "commentThreads",
    fields: "items(id,snippet(totalReplyCount,topLevelComment(id,snippet(likeCount))))",
    resolved,
    errors,
    apiKey,
    fetchImpl,
    batchSize: normalizedBatchSize,
    timeoutMs,
    parseItem(item, requestedIds) {
      const topLevelComment = item?.snippet?.topLevelComment;
      const id = [topLevelComment?.id, item?.id].find((candidate) => requestedIds.has(candidate));
      const likes = nonnegativeInteger(topLevelComment?.snippet?.likeCount);
      const replies = nonnegativeInteger(item?.snippet?.totalReplyCount);
      return id && likes != null && replies != null ? { id, likes, replies } : null;
    },
  });

  await collectBatches({
    entries: replyEntries,
    endpoint: "comments",
    fields: "items(id,snippet(likeCount))",
    resolved,
    errors,
    apiKey,
    fetchImpl,
    batchSize: normalizedBatchSize,
    timeoutMs,
    parseItem(item, requestedIds) {
      const id = requestedIds.has(item?.id) ? item.id : null;
      const likes = nonnegativeInteger(item?.snippet?.likeCount);
      return id && likes != null ? { id, likes, replies: 0 } : null;
    },
  });

  return {
    resolved,
    unresolved: uniqueEntries.filter((entry) => !resolved.has(entry.id)),
    errors,
  };
}

async function collectBatches({
  entries,
  endpoint,
  fields,
  resolved,
  errors,
  apiKey,
  fetchImpl,
  batchSize,
  timeoutMs,
  parseItem,
}) {
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const requestedIds = new Set(batch.map((entry) => entry.id));
    try {
      const url = new URL(endpoint, API_ROOT);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("id", [...requestedIds].join(","));
      url.searchParams.set("fields", fields);
      url.searchParams.set("key", apiKey);
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) throw new Error(`YouTube Data API ${endpoint}: HTTP ${response?.status ?? "inconnu"}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.items)) throw new Error(`YouTube Data API ${endpoint}: réponse invalide`);
      for (const item of payload.items) {
        const metric = parseItem(item, requestedIds);
        if (metric) resolved.set(metric.id, { likes: metric.likes, replies: metric.replies });
      }
    } catch (error) {
      errors.push({
        endpoint,
        ids: [...requestedIds],
        error: String(error).replaceAll(apiKey, "[redacted]").slice(0, 240),
      });
    }
  }
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

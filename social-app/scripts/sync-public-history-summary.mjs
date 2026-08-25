import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { matchesSocialFormatFilter } from "../lib/social-formats.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historyPath = resolve(root, "data", "public-history.json");
const summaryPath = resolve(root, "data", "public-history-summary.json");
const platforms = ["youtube", "instagram", "tiktok", "x"];

export function buildPublicHistorySummary(history, previousSummary) {
  if (
    !history ||
    typeof history.generatedAt !== "string" ||
    !Array.isArray(history.posts) ||
    !Array.isArray(history.coverage)
  ) {
    throw new Error("Historique public invalide.");
  }
  if (!previousSummary?.formatCounts || typeof previousSummary.formatCounts !== "object") {
    throw new Error("Résumé public précédent invalide.");
  }

  const platformCounts = {};
  const formatCounts = {};
  for (const platform of platforms) {
    const posts = history.posts.filter((post) => post?.platform === platform);
    platformCounts[platform] = posts.length;
    const filters = Object.keys(previousSummary.formatCounts[platform] ?? {});
    formatCounts[platform] = Object.fromEntries(filters.map((filter) => [
      filter,
      posts.filter((post) => matchesSocialFormatFilter(post, filter)).length,
    ]));
  }

  return {
    generatedAt: history.generatedAt,
    totalPostCount: history.posts.length,
    platformCounts,
    formatCounts,
    coverage: history.coverage,
  };
}

async function main() {
  const [history, previousSummary] = await Promise.all([
    readFile(historyPath, "utf8").then(JSON.parse),
    readFile(summaryPath, "utf8").then(JSON.parse),
  ]);
  const summary = buildPublicHistorySummary(history, previousSummary);
  const temporaryPath = `${summaryPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await rename(temporaryPath, summaryPath);
  console.log(`Résumé public synchronisé : ${summary.totalPostCount} contenus.`);
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) await main();

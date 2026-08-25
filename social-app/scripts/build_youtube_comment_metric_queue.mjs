import { readFile, writeFile } from "node:fs/promises";

const sourcePath = new URL("../data/private-youtube-comment-history.json", import.meta.url);
const outputPath = new URL("../data/youtube-comment-metric-queue.json", import.meta.url);

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const queue = (source.comments ?? []).flatMap((entry) => {
  if (typeof entry?.url !== "string") return [];
  try {
    const id = new URL(entry.url).searchParams.get("lc");
    return id ? [{ id, url: entry.url }] : [];
  } catch {
    return [];
  }
});

const unique = [...new Map(queue.map((entry) => [entry.id, entry])).values()];
await writeFile(outputPath, `${JSON.stringify({ schema: 1, comments: unique }, null, 2)}\n`, "utf8");
console.log(`Prepared ${unique.length} YouTube comment URLs.`);

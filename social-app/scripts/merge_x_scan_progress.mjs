import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const progressPath = resolve(root, "work", "x-scan-progress.json");
const batchPath = resolve(process.argv[2] ?? "work/x-batch-latest.json");
const backupPath = `${progressPath}.backup`;

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

const progress = await readJson(progressPath, { posts: [] });
const batch = await readJson(batchPath, []);
const currentPosts = Array.isArray(progress.posts) ? progress.posts : [];
const batchPosts = Array.isArray(batch) ? batch : Array.isArray(batch.posts) ? batch.posts : [];

const byId = new Map();
for (const post of [...currentPosts, ...batchPosts]) {
  if (!post?.id) continue;
  byId.set(String(post.id), { ...byId.get(String(post.id)), ...post, id: String(post.id) });
}

const posts = [...byId.values()].sort((a, b) => {
  const dateOrder = String(b.time ?? "").localeCompare(String(a.time ?? ""));
  return dateOrder || String(b.id).localeCompare(String(a.id));
});

if (posts.length < currentPosts.length) {
  throw new Error(`Refus de réduire le scan X de ${currentPosts.length} à ${posts.length} posts.`);
}

const next = {
  updatedAt: new Date().toISOString(),
  posts,
};
const tempPath = `${progressPath}.next`;

await writeFile(backupPath, JSON.stringify(progress, null, 2) + "\n", "utf8");
await writeFile(tempPath, JSON.stringify(next, null, 2) + "\n", "utf8");
await rename(tempPath, progressPath);

process.stdout.write(JSON.stringify({
  before: currentPosts.length,
  batch: batchPosts.length,
  after: posts.length,
  added: posts.length - currentPosts.length,
  oldest: posts.map((post) => post.time).filter(Boolean).sort()[0] ?? null,
  newest: posts.map((post) => post.time).filter(Boolean).sort().at(-1) ?? null,
}));

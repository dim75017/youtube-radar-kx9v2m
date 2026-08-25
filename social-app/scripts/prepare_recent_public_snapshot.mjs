import { readFile, writeFile } from "node:fs/promises";

const snapshotPath = new URL("../data/recent-public.json", import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

// The historical snapshot already owns YouTube and TikTok. Keep only the X
// overlay needed by the static preview and strip query strings from media URLs.
snapshot.accounts = (snapshot.accounts ?? []).filter(
  (account) => account.platform === "x",
);
snapshot.posts = (snapshot.posts ?? [])
  .filter((post) => post.platform === "x")
  .map((post) => ({
    ...post,
    thumbnail_url: post.thumbnail_url?.split("?")[0] ?? null,
  }));
snapshot.scans = (snapshot.scans ?? []).filter((scan) => scan.platform === "x");
delete snapshot.analysis;

await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

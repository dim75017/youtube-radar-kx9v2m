import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = resolve(ROOT, "data", "public-history.json");
const PROGRESS_PATH = resolve(ROOT, "work", "instagram-embed-progress.json");
const TARGET_DIR = resolve(ROOT, "work", "gh-pages", "media", "instagram");
const PUBLIC_BASE = "https://dim75017.github.io/lofi-social-radar-preview/media/instagram";
const CONCURRENCY = 16;
const RETRIES = 2;
const TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5_000_000;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function writeAtomically(path, bytes) {
  const temporary = `${path}.${process.pid}.${Date.now()}.next`;
  try {
    await writeFile(temporary, bytes);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 8) throw error;
        await sleep(attempt * 75);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function usableCachedImage(path) {
  try {
    return (await stat(path)).size > 1_000;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function download(post, fallbackUrl) {
  const target = resolve(TARGET_DIR, `${post.externalId}.jpg`);
  if (await usableCachedImage(target)) return { cached: true };
  const source = post.thumbnailUrl;
  if (typeof source !== "string" || !/^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]+\/media\//.test(source)) {
    throw new Error(`Miniature Instagram source invalide pour ${post.externalId}.`);
  }
  let lastError = null;
  const sources = [fallbackUrl, source].filter((value, index, values) =>
    typeof value === "string" && value.startsWith("https://") && values.indexOf(value) === index);
  for (const candidate of sources) {
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        const response = await fetch(candidate, {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.httpStatus = response.status;
          throw error;
        }
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.startsWith("image/jpeg")) throw new Error(`type inattendu ${contentType || "absent"}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 1_000 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
          throw new Error(`JPEG invalide (${bytes.length} octets)`);
        }
        await writeAtomically(target, bytes);
        return { cached: false };
      } catch (error) {
        lastError = error;
        if ([403, 404, 410, 429].includes(error?.httpStatus)) break;
        if (attempt < RETRIES) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      }
    }
  }
  throw new Error(`${post.externalId}: ${lastError?.message ?? lastError}`);
}

async function main() {
  const snapshot = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  const progress = JSON.parse(await readFile(PROGRESS_PATH, "utf8"));
  const instagram = snapshot.posts.filter((post) => post?.platform === "instagram");
  if (instagram.length !== 1_676 || new Set(instagram.map((post) => post.externalId)).size !== instagram.length) {
    throw new Error(`Historique Instagram inattendu : ${instagram.length} publications.`);
  }
  await mkdir(TARGET_DIR, { recursive: true });
  let cursor = 0;
  let downloaded = 0;
  let cached = 0;
  const worker = async () => {
    while (cursor < instagram.length) {
      const post = instagram[cursor++];
      const result = await download(post, progress.items?.[post.externalId]?.post?.imageUrl ?? null);
      if (result.cached) cached += 1;
      else downloaded += 1;
      const completed = downloaded + cached;
      if (completed % 50 === 0 || completed === instagram.length) {
        process.stdout.write(`${JSON.stringify({ phase: "thumbnails", completed, total: instagram.length, downloaded, cached })}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const next = {
    ...snapshot,
    posts: snapshot.posts.map((post) => post?.platform === "instagram"
      ? { ...post, thumbnailUrl: `${PUBLIC_BASE}/${post.externalId}.jpg` }
      : post),
  };
  await writeAtomically(HISTORY_PATH, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
  process.stdout.write(`${JSON.stringify({ phase: "complete", instagram: instagram.length, downloaded, cached })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

import { createHash } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIVITY_URL = "https://www.instagram.com/your_activity/interactions/comments/";
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
  "headless-inventory.checkpoint.json",
);

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nullableCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function exactTimestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    return Number.isFinite(new Date(milliseconds).getTime())
      ? new Date(milliseconds).toISOString()
      : null;
  }
  const text = nullableString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function strictShortcode(value) {
  const text = nullableString(value);
  return text && /^[A-Za-z0-9_-]{5,32}$/u.test(text) ? text : null;
}

function strictNativeId(value) {
  const text = value == null ? null : String(value);
  return text && /^\d{10,30}$/u.test(text) ? text : null;
}

function strictInstagramThumbnail(value) {
  const text = nullableString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)(?:cdninstagram\.com|fbcdn\.net)$/iu.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function usernameFrom(value) {
  if (!isRecord(value)) return null;
  return nullableString(value.username ?? value.user_name ?? value.handle)?.replace(/^@/u, "");
}

function mediaContext(value, inherited = null) {
  if (!isRecord(value)) return inherited;
  const media = [value.media, value.media_or_ad, value.target_media, value.clips_media]
    .find(isRecord) ?? null;
  const source = media ?? value;
  const shortcode = strictShortcode(
    source.code ?? source.shortcode ?? source.media_code ?? value.media_code ?? value.shortcode,
  );
  if (!shortcode) return inherited;
  const product = nullableString(source.product_type ?? source.media_type_name)?.toLowerCase();
  const kind = product?.includes("clip") || product?.includes("reel") ? "reel" : "p";
  const mediaUser = [source.user, source.owner].find(isRecord) ?? null;
  const caption = isRecord(source.caption) ? source.caption : null;
  const candidates = source.image_versions2?.candidates;
  return {
    shortcode,
    url: `https://www.instagram.com/${kind}/${shortcode}/`,
    title: nullableString(caption?.text ?? source.caption_text),
    thumbnailUrl: strictInstagramThumbnail(
      source.thumbnail_url ?? source.display_url ?? (Array.isArray(candidates) ? candidates[0]?.url : null),
    ),
    authorHandle: usernameFrom(mediaUser),
    authorName: nullableString(mediaUser?.full_name),
  };
}

function commentRecord(value, inheritedMedia, capturedAt) {
  if (!isRecord(value)) return null;
  const user = [value.user, value.owner, value.author].find(isRecord) ?? null;
  const username = usernameFrom(user) ?? nullableString(value.username)?.replace(/^@/u, "");
  if (username?.toLowerCase() !== "lofigirl") return null;
  const id = strictNativeId(value.pk ?? value.id ?? value.comment_id);
  const text = nullableString(value.text ?? value.comment_text ?? value.body);
  const publishedAt = exactTimestamp(
    value.created_at_utc ?? value.created_at ?? value.timestamp ?? value.taken_at,
  );
  const media = mediaContext(value, inheritedMedia);
  if (!id || !text || !publishedAt || !media) return null;
  const deepUrl = `${media.url}c/${id}/`;
  return {
    id,
    idKind: "native",
    url: deepUrl,
    text,
    publishedAt,
    publishedAtPrecision: "exact",
    target: {
      contentId: media.shortcode,
      url: media.url,
      status: "available",
      unavailable: false,
      title: media.title ?? "Contenu Instagram commenté",
      thumbnailUrl: media.thumbnailUrl,
      authorHandle: media.authorHandle,
      authorName: media.authorName,
      authorProfileUrl: media.authorHandle
        ? `https://www.instagram.com/${media.authorHandle}/`
        : null,
      audienceValue: null,
      audienceLabel: null,
      audiencePrecision: "unknown",
      audienceObservedAt: null,
    },
    metrics: {
      likes: nullableCount(value.comment_like_count ?? value.like_count),
      replies: nullableCount(
        value.child_comment_count ?? value.reply_count ?? value.num_replies,
      ),
    },
    observation: {
      observedAt: capturedAt,
      relativeAge: null,
      stableSyntheticId: null,
    },
  };
}

export function extractClosedInstagramComments(payload, capturedAt) {
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("capturedAt doit être une date ISO valide.");
  }
  const comments = [];
  const seenObjects = new Set();
  const visit = (value, inheritedMedia = null) => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedMedia);
      return;
    }
    const nextMedia = mediaContext(value, inheritedMedia);
    const record = commentRecord(value, nextMedia, capturedAt);
    if (record) comments.push(record);
    for (const child of Object.values(value)) visit(child, nextMedia);
  };
  visit(payload);
  return mergeInstagramInventory([], comments).comments;
}

export function extractPaginationEvidence(payload) {
  const evidence = [];
  const visit = (value) => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const booleanValue = [value.has_next_page, value.more_available, value.has_more]
      .find((item) => typeof item === "boolean");
    const cursor = nullableString(
      value.end_cursor ?? value.next_max_id ?? value.next_cursor ?? value.cursor,
    );
    if (typeof booleanValue === "boolean" && (cursor || booleanValue === false)) {
      evidence.push({
        hasNext: booleanValue,
        cursorHash: cursor ? hash(cursor) : null,
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return evidence;
}

export function mergeInstagramInventory(existing, incoming) {
  const comments = new Map();
  const collisions = [];
  for (const record of [...existing, ...incoming]) {
    if (!isRecord(record) || !strictNativeId(record.id)) continue;
    const previous = comments.get(record.id);
    if (!previous) {
      comments.set(record.id, record);
      continue;
    }
    const sameIdentity =
      previous.text === record.text &&
      previous.url === record.url &&
      previous.publishedAt === record.publishedAt;
    if (!sameIdentity) {
      collisions.push({ id: record.id, reason: "native-id-identity-conflict" });
      continue;
    }
    comments.set(record.id, {
      ...previous,
      metrics: {
        likes: record.metrics?.likes ?? previous.metrics?.likes ?? null,
        replies: record.metrics?.replies ?? previous.metrics?.replies ?? null,
      },
      observation: {
        ...previous.observation,
        observedAt: record.observation?.observedAt ?? previous.observation?.observedAt,
      },
    });
  }
  return {
    comments: [...comments.values()].sort((left, right) =>
      left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id)),
    collisions,
  };
}

export function assessInstagramInventoryCompletion(state) {
  const cursorExhausted = state.cursorExhausted === true;
  const boundaryStallCount = nullableCount(state.boundaryStallCount) ?? 0;
  const stableReconciliationPasses = nullableCount(state.stableReconciliationPasses) ?? 0;
  const unresolvedThreadCount = nullableCount(state.unresolvedThreadCount) ?? 0;
  const collisionCount = nullableCount(state.collisionCount) ?? 0;
  const complete =
    state.allTimeSelected === true &&
    state.boundaryReached === true &&
    stableReconciliationPasses >= 2 &&
    (cursorExhausted || boundaryStallCount >= 3) &&
    unresolvedThreadCount === 0 &&
    collisionCount === 0;
  return {
    inventoryStatus: complete ? "complete" : "partial",
    endReached: complete,
    completionProof: {
      allTimeSelected: state.allTimeSelected === true,
      boundaryReached: state.boundaryReached === true,
      cursorExhausted,
      boundaryStallCount,
      stableReconciliationPasses,
    },
    issues: [
      ...(state.allTimeSelected === true ? [] : ["all-time-filter-not-proven"]),
      ...(state.boundaryReached === true ? [] : ["all-time-boundary-not-reached"]),
      ...((cursorExhausted || boundaryStallCount >= 3) ? [] : ["pagination-not-exhausted"]),
      ...(stableReconciliationPasses >= 2 ? [] : ["reconciliation-pass-missing"]),
      ...(unresolvedThreadCount === 0 ? [] : ["hidden-threads-not-exhausted"]),
      ...(collisionCount === 0 ? [] : ["identity-collision"]),
    ],
  };
}

export function assertDedicatedInstagramProfilePath(value) {
  const profile = resolve(value);
  const child = relative(DEDICATED_PROFILE_ROOT, profile);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Le profil doit rester sous work/owner-comments/browser-profiles/.");
  }
  return profile;
}

function accessState(url, text) {
  const normalizedUrl = String(url ?? "").toLowerCase();
  const normalizedText = String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
  if (
    normalizedUrl.includes("/challenge/") ||
    normalizedUrl.includes("/checkpoint/") ||
    /confirm it'?s you|challenge required|suspicious login|help us confirm/iu.test(normalizedText)
  ) return "challenge";
  if (
    normalizedUrl.includes("/accounts/login") ||
    /log in to instagram|sign up to see photos/iu.test(normalizedText)
  ) return "unauthenticated";
  if (/please wait a few minutes|try again later|too many requests/iu.test(normalizedText)) {
    return "rate-limited";
  }
  return "ready";
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function playwrightModule() {
  const bundledEntry = resolve(dirname(process.execPath), "..", "node_modules", "playwright", "index.mjs");
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
  throw new Error("Playwright est absent.", { cause: lastError });
}

function parseOptions(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    profile: DEFAULT_PROFILE,
    maxIterations: 200,
    delayMs: 1_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--profile") options.profile = assertDedicatedInstagramProfilePath(argv[++index]);
    else if (argument === "--max-iterations") options.maxIterations = Number(argv[++index]);
    else if (argument === "--delay-ms") options.delayMs = Number(argv[++index]);
    else throw new Error(`Option inconnue : ${argument}`);
  }
  if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error("--max-iterations doit être un entier positif.");
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 750) {
    throw new Error("--delay-ms doit être un entier supérieur ou égal à 750.");
  }
  options.profile = assertDedicatedInstagramProfilePath(options.profile);
  return options;
}

async function visibleBodyText(page) {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

async function allTimeVisible(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = globalThis.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    return [...globalThis.document.querySelectorAll("button, [role='button'], [role='option']")]
      .filter(visible)
      .some((element) => {
        const exactLabel = /^(all time|depuis toujours|tout le temps)$/iu.test(
          String(element.textContent ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim(),
        );
        if (!exactLabel) return false;
        return [
          element.getAttribute("aria-selected"),
          element.getAttribute("aria-pressed"),
          element.getAttribute("aria-checked"),
          element.getAttribute("data-state"),
        ].some((value) => value === "true" || value === "checked");
      });
  });
}

async function clickUniqueVisibleLabel(page, labels, allowButton) {
  return page.evaluate(({ exactLabels, includeButton }) => {
    const normalize = (value) => String(value ?? "").normalize("NFKC")
      .replace(/\s+/gu, " ").trim().toLowerCase();
    const visible = (element) => {
      const style = globalThis.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const selector = includeButton
      ? "button, [role='button'], [role='option'], [role='menuitemradio'], [role='radio']"
      : "[role='option'], [role='menuitemradio'], [role='radio']";
    const matches = [...globalThis.document.querySelectorAll(selector)]
      .filter(visible)
      .filter((element) => !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true")
      .filter((element) => exactLabels.includes(normalize(element.textContent)));
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }, {
    exactLabels: labels.map((label) => label.toLowerCase()),
    includeButton: allowButton,
  });
}

async function selectAllTime(page) {
  if (await allTimeVisible(page)) {
    return {
      selected: true,
      triggerClicked: false,
      optionClicked: false,
      applyClicked: false,
      postClickVerified: true,
    };
  }
  let triggerClicked = false;
  for (const labels of [
    ["Date range", "Plage de dates"],
    ["Sort & filter", "Trier et filtrer"],
  ]) {
    if (await clickUniqueVisibleLabel(page, labels, true)) {
      triggerClicked = true;
      await page.waitForTimeout(500);
      break;
    }
  }
  const optionClicked = await clickUniqueVisibleLabel(
    page,
    ["All time", "Depuis toujours", "Tout le temps"],
    triggerClicked,
  );
  if (optionClicked) await page.waitForTimeout(500);
  const applyClicked = optionClicked
    ? await clickUniqueVisibleLabel(page, ["Apply", "Appliquer"], true)
    : false;
  if (applyClicked) await page.waitForTimeout(750);
  const postClickVerified = await allTimeVisible(page);
  return {
    selected: postClickVerified,
    triggerClicked,
    optionClicked,
    applyClicked,
    postClickVerified,
  };
}

async function expandVisibleThreads(page) {
  return page.evaluate(() => {
    const pattern = /^(view entire thread|voir tout le fil|afficher tout le fil)$/iu;
    const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const elements = [...globalThis.document.querySelectorAll("button, [role='button']")]
      .filter((element) => pattern.test(
        normalize(element.textContent),
      ));
    const audit = globalThis.__lofiInstagramThreadAudit ?? {
      identified: new Set(),
      attempted: new Set(),
      expanded: new Set(),
      unresolved: new Set(),
      pending: new Map(),
    };
    globalThis.__lofiInstagramThreadAudit = audit;
    const ordinals = new Map();
    for (const element of elements) {
      const container = element.closest("li, [role='listitem']") ?? element.parentElement;
      const base = `${normalize(container?.innerText)}|${[...(container?.querySelectorAll("img") ?? [])]
        .map((image) => image.getAttribute("src") ?? "").join("|")}`;
      const ordinal = ordinals.get(base) ?? 0;
      ordinals.set(base, ordinal + 1);
      const fingerprint = `${base}|${ordinal}`;
      audit.identified.add(fingerprint);
      audit.attempted.add(fingerprint);
      audit.pending.set(fingerprint, {
        container,
        beforeChildCount: container?.querySelectorAll("*").length ?? 0,
        beforeTextLength: normalize(container?.innerText).length,
      });
      element.click();
    }
    return {
      identified: audit.identified.size,
      attempted: audit.attempted.size,
      clickedNow: elements.length,
    };
  });
}

async function assessVisibleThreadExpansions(page) {
  return page.evaluate(() => {
    const pattern = /^(view entire thread|voir tout le fil|afficher tout le fil)$/iu;
    const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const audit = globalThis.__lofiInstagramThreadAudit;
    if (!audit) return { identified: 0, attempted: 0, expanded: 0, unresolved: 0 };
    for (const [fingerprint, pending] of audit.pending) {
      const container = pending.container;
      const buttonRemains = container?.isConnected && [...container.querySelectorAll(
        "button, [role='button']",
      )].some((element) => pattern.test(normalize(element.textContent)));
      const contentExpanded = container?.isConnected && !buttonRemains && (
        container.querySelectorAll("*").length > pending.beforeChildCount ||
        normalize(container.innerText).length > pending.beforeTextLength
      );
      if (contentExpanded) {
        audit.unresolved.delete(fingerprint);
        audit.expanded.add(fingerprint);
      }
      else audit.unresolved.add(fingerprint);
    }
    audit.pending.clear();
    return {
      identified: audit.identified.size,
      attempted: audit.attempted.size,
      expanded: audit.expanded.size,
      unresolved: audit.unresolved.size,
    };
  });
}

async function extractDomComments(page, capturedAt) {
  const rows = await page.evaluate(() => {
    const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const result = [];
    for (const container of globalThis.document.querySelectorAll("li, [role='listitem']")) {
      const author = [...container.querySelectorAll("a[href]")].find((anchor) => {
        try {
          return new URL(anchor.getAttribute("href"), globalThis.location.origin).pathname
            .replace(/\/+$/u, "").toLowerCase() === "/lofigirl";
        } catch {
          return false;
        }
      });
      if (!author) continue;
      const deep = [...container.querySelectorAll("a[href]")].map((anchor) => {
        try { return new URL(anchor.getAttribute("href"), globalThis.location.origin).href; }
        catch { return null; }
      }).find((href) => /\/c\/\d{10,30}\/?(?:[?#].*)?$/iu.test(href ?? ""));
      const time = container.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
      const explicit = container.matches("[data-comment-id]")
        ? container
        : container.querySelector("[data-comment-id]");
      const explicitId = explicit?.getAttribute("data-comment-id") ?? null;
      const explicitText = explicit?.querySelector("[data-comment-text]")?.getAttribute("data-comment-text")
        ?? explicit?.getAttribute("data-comment-text")
        ?? null;
      const deepId = deep?.match(/\/c\/(\d{10,30})\/?(?:[?#].*)?$/iu)?.[1] ?? null;
      if (!deep || !time || !explicitId || explicitId !== deepId || !normalize(explicitText)) continue;
      result.push({ deep, time, text: normalize(explicitText) });
    }
    return result;
  });
  return rows.flatMap((row) => {
    try {
      const url = new URL(row.deep);
      const match = url.pathname.match(/^\/(p|reel|tv)\/([^/?#]+)\/c\/(\d{10,30})\/?$/iu);
      const publishedAt = exactTimestamp(row.time);
      if (!match || !publishedAt) return [];
      return [{
        id: match[3],
        idKind: "native",
        url: `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/c/${match[3]}/`,
        text: row.text,
        publishedAt,
        publishedAtPrecision: "exact",
        target: {
          contentId: match[2],
          url: `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`,
          status: "available",
          unavailable: false,
          title: "Contenu Instagram commenté",
          thumbnailUrl: null,
          authorHandle: null,
          authorName: null,
          authorProfileUrl: null,
          audienceValue: null,
          audienceLabel: null,
          audiencePrecision: "unknown",
          audienceObservedAt: null,
        },
        metrics: { likes: null, replies: null },
        observation: { observedAt: capturedAt, relativeAge: null, stableSyntheticId: null },
      }];
    } catch {
      return [];
    }
  });
}

async function scrollInventory(page) {
  return page.evaluate(() => {
    const isLofiRow = (row) => [...row.querySelectorAll("a[href]")].some((anchor) => {
      try {
        return new URL(anchor.getAttribute("href"), globalThis.location.origin).pathname
          .replace(/\/+$/u, "").toLowerCase() === "/lofigirl";
      } catch {
        return false;
      }
    });
    const existing = globalThis.document.querySelector("[data-codex-instagram-inventory-scroller='true']");
    const existingIsValid = existing &&
      existing.scrollHeight > existing.clientHeight + 50 &&
      [...existing.querySelectorAll("li, [role='listitem']")].some(isLofiRow);
    const candidates = [...globalThis.document.querySelectorAll("main, [role='main'], main *, [role='main'] *")]
      .filter((element) => element.scrollHeight > element.clientHeight + 50)
      .map((element) => ({
        element,
        attributableRows: [...element.querySelectorAll("li, [role='listitem']")]
          .filter(isLofiRow).length,
      }))
      .filter((candidate) => candidate.attributableRows > 0)
      .sort((left, right) =>
        right.attributableRows - left.attributableRows ||
        (right.element.scrollHeight - right.element.clientHeight) -
          (left.element.scrollHeight - left.element.clientHeight));
    const scroller = existingIsValid ? existing : candidates[0]?.element ?? null;
    if (!scroller) {
      return {
        validatedScroller: false,
        boundaryReached: false,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      };
    }
    scroller.setAttribute("data-codex-instagram-inventory-scroller", "true");
    scroller.scrollTop = scroller.scrollHeight;
    return {
      validatedScroller: true,
      boundaryReached: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  });
}

async function collect(options) {
  const capturedAt = new Date().toISOString();
  const checkpoint = {
    platform: "instagram",
    capturedAt,
    activitySourceUrl: ACTIVITY_URL,
    inventory: {
      inventoryStatus: "partial",
      endReached: false,
      recordCount: 0,
      issues: ["collection-not-started"],
      completionProof: null,
    },
    collection: {
      mode: "isolated-headless-all-time-inventory",
      profileDirectory: "private-ignored-work-directory",
      allTimeSelected: false,
      allTimeSelection: null,
      passesCompleted: 0,
      responseBatches: 0,
      cursorEvidenceCount: 0,
      responseParseFailureCount: 0,
      threadCardsIdentified: 0,
      threadCardsAttempted: 0,
      threadCardsExpanded: 0,
      unresolvedThreadCount: 0,
      reconciliationResetProven: false,
      stoppedReason: null,
      scrollLog: [],
    },
    comments: [],
    collisions: [],
  };
  await writeJsonAtomically(options.output, checkpoint);
  const { chromium } = await playwrightModule();
  const context = await chromium.launchPersistentContext(options.profile, {
    headless: true,
    channel: "chrome",
    locale: "en-US",
    timezoneId: "Europe/Paris",
    viewport: { width: 1_440, height: 1_200 },
    args: ["--autoplay-policy=user-gesture-required", "--mute-audio"],
  });
  await context.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (["media", "font"].includes(type)) await route.abort();
    else await route.continue();
  });
  const page = context.pages()[0] ?? await context.newPage();
  let responseChain = Promise.resolve();
  const acceptRecords = (records) => {
    const merged = mergeInstagramInventory(checkpoint.comments, records);
    checkpoint.comments = merged.comments;
    checkpoint.collisions.push(...merged.collisions);
    checkpoint.inventory.recordCount = checkpoint.comments.length;
  };
  page.on("response", (response) => {
    responseChain = responseChain.then(async () => {
      const request = response.request();
      if (!["xhr", "fetch"].includes(request.resourceType())) return;
      const url = new URL(response.url());
      if (!/(^|\.)instagram\.com$/iu.test(url.hostname)) return;
      const contentType = response.headers()["content-type"] ?? "";
      if (!/json/iu.test(contentType)) return;
      const payload = await response.json().catch(() => null);
      if (!payload) return;
      const records = extractClosedInstagramComments(payload, capturedAt);
      const pagination = records.length > 0 ? extractPaginationEvidence(payload) : [];
      if (records.length > 0 || pagination.length > 0) checkpoint.collection.responseBatches += 1;
      acceptRecords(records);
      checkpoint.collection.cursorEvidenceCount += pagination.length;
      await writeJsonAtomically(options.output, checkpoint);
    }).catch(() => {
      checkpoint.collection.responseParseFailureCount += 1;
    });
  });
  try {
    await page.goto(ACTIVITY_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1_500);
    const state = accessState(page.url(), await visibleBodyText(page));
    if (state !== "ready") {
      checkpoint.collection.stoppedReason = state;
      checkpoint.inventory.issues = [state];
      await writeJsonAtomically(options.output, checkpoint);
      throw new Error(`Collecte Instagram interrompue : ${state}.`);
    }
    checkpoint.collection.allTimeSelection = await selectAllTime(page);
    checkpoint.collection.allTimeSelected = checkpoint.collection.allTimeSelection.selected;
    let stableReconciliationPasses = 0;
    let lastPassCount = -1;
    let bestBoundaryStall = 0;
    let boundaryReached = false;
    for (let pass = 1; pass <= 2; pass += 1) {
      let noGrowth = 0;
      let previousHeight = null;
      let iteration = 0;
      while (iteration < options.maxIterations) {
        iteration += 1;
        const before = checkpoint.comments.length;
        const threadAudit = await expandVisibleThreads(page);
        checkpoint.collection.threadCardsIdentified = threadAudit.identified;
        checkpoint.collection.threadCardsAttempted = threadAudit.attempted;
        await page.waitForTimeout(options.delayMs);
        const currentPath = new URL(page.url()).pathname.replace(/\/+$/u, "");
        const activityPath = new URL(ACTIVITY_URL).pathname.replace(/\/+$/u, "");
        if (currentPath !== activityPath) {
          checkpoint.collection.stoppedReason = "thread-expansion-navigation";
          await writeJsonAtomically(options.output, checkpoint);
          throw new Error("L’expansion d’un fil a quitté la vue d’activité.");
        }
        const expandedAudit = await assessVisibleThreadExpansions(page);
        checkpoint.collection.threadCardsIdentified = expandedAudit.identified;
        checkpoint.collection.threadCardsAttempted = expandedAudit.attempted;
        checkpoint.collection.threadCardsExpanded = expandedAudit.expanded;
        checkpoint.collection.unresolvedThreadCount = expandedAudit.unresolved;
        acceptRecords(await extractDomComments(page, capturedAt));
        await responseChain;
        const scroll = await scrollInventory(page);
        await page.waitForTimeout(options.delayMs);
        await responseChain;
        const added = checkpoint.comments.length - before;
        const stableHeight = previousHeight === scroll.scrollHeight;
        noGrowth = added === 0 && scroll.boundaryReached && stableHeight ? noGrowth + 1 : 0;
        previousHeight = scroll.scrollHeight;
        boundaryReached ||= scroll.boundaryReached;
        bestBoundaryStall = Math.max(bestBoundaryStall, noGrowth);
        checkpoint.collection.scrollLog.push({
          pass,
          iteration,
          added,
          total: checkpoint.comments.length,
          boundaryReached: scroll.boundaryReached,
          validatedScroller: scroll.validatedScroller,
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
          clientHeight: scroll.clientHeight,
        });
        await writeJsonAtomically(options.output, checkpoint);
        if (noGrowth >= 3) break;
      }
      checkpoint.collection.passesCompleted = pass;
      if (checkpoint.comments.length === lastPassCount) stableReconciliationPasses += 1;
      else stableReconciliationPasses = 1;
      lastPassCount = checkpoint.comments.length;
      if (pass < 2) {
        const resetProven = await page.evaluate(() => {
          const isLofiRow = (row) => [...row.querySelectorAll("a[href]")].some((anchor) => {
            try {
              return new URL(anchor.getAttribute("href"), globalThis.location.origin).pathname
                .replace(/\/+$/u, "").toLowerCase() === "/lofigirl";
            } catch {
              return false;
            }
          });
          const scroller = globalThis.document.querySelector(
            "[data-codex-instagram-inventory-scroller='true']",
          );
          if (!scroller || ![...scroller.querySelectorAll("li, [role='listitem']")].some(isLofiRow)) {
            return false;
          }
          scroller.scrollTop = 0;
          return scroller.scrollTop <= 4;
        });
        checkpoint.collection.reconciliationResetProven = resetProven;
        if (!resetProven) break;
        await page.waitForTimeout(options.delayMs);
      }
    }
    const assessment = assessInstagramInventoryCompletion({
      allTimeSelected: checkpoint.collection.allTimeSelected,
      boundaryReached,
      cursorExhausted: false,
      boundaryStallCount: bestBoundaryStall,
      stableReconciliationPasses,
      unresolvedThreadCount: checkpoint.collection.unresolvedThreadCount,
      collisionCount: checkpoint.collisions.length,
    });
    checkpoint.inventory = {
      ...assessment,
      recordCount: checkpoint.comments.length,
    };
    checkpoint.collection.stoppedReason = assessment.endReached ? null : "inventory-partial";
    await writeJsonAtomically(options.output, checkpoint);
    return checkpoint;
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await collect(options);
  process.stdout.write(`${JSON.stringify({
    output: options.output,
    inventoryStatus: result.inventory.inventoryStatus,
    endReached: result.inventory.endReached,
    recordCount: result.inventory.recordCount,
    stoppedReason: result.collection.stoppedReason,
  }, null, 2)}\n`);
  if (!result.inventory.endReached) process.exitCode = 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

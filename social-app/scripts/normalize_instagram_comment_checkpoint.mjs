import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM = "instagram";
const ACTIVITY_SOURCE_URL = "https://www.instagram.com/your_activity/interactions/comments/";
const DEFAULT_INPUT = resolve(
  "work",
  "owner-comments",
  "2026-08-31",
  "instagram",
  "observations.checkpoint.json",
);

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} doit être une chaîne non vide.`);
  }
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function instagramPermalink(value, shortcode) {
  if (value == null) return null;
  const url = new URL(requireString(value, "comment.url"));
  if (url.protocol !== "https:" || !/(^|\.)instagram\.com$/i.test(url.hostname)) {
    throw new Error(`URL Instagram invalide : ${value}`);
  }
  const match = url.pathname.match(/^\/(?:p|reel|tv)\/([^/?#]+)/i);
  if (!match) throw new Error(`Permalien Instagram non reconnu : ${value}`);
  if (shortcode && match[1] !== shortcode) {
    throw new Error(`Shortcode contradictoire pour ${value}.`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return { url: url.toString(), shortcode: shortcode ?? match[1] };
}

function thumbnailFingerprint(value) {
  const thumbnailUrl = nullableString(value);
  if (!thumbnailUrl) return null;
  const url = new URL(thumbnailUrl);
  const filename = basename(url.pathname).replace(/\.(?:jpe?g|webp|png)$/i, "");
  return filename || hash(url.pathname);
}

function canonicalShortcode(...values) {
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    try {
      const url = new URL(value);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) continue;
      const match = url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/iu);
      if (match) return match[1];
    } catch {
      if (/^[A-Za-z0-9_-]{5,40}$/u.test(value)) return value;
    }
  }
  return null;
}

function normalizedCaption(value) {
  const caption = nullableString(value);
  return caption?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? null;
}

function existingCaption(post, authorHandle) {
  const target = assertRecord(post.raw?.commentTarget ?? {}, "existing.raw.commentTarget");
  const caption = normalizedCaption(target.title ?? post.title);
  if (!caption || !authorHandle) return caption;
  for (const prefix of [`${authorHandle} `, `@${authorHandle} `]) {
    if (caption.toLowerCase().startsWith(prefix.toLowerCase())) {
      return caption.slice(prefix.length).trim() || null;
    }
  }
  return caption.toLowerCase() === authorHandle.toLowerCase() ? null : caption;
}

function existingIdKind(post, suffix) {
  const explicit = post.raw?.commentIdKind;
  if (explicit === "native" || explicit === "synthetic") return explicit;
  if (post.raw?.nativeCommentId) return "native";
  return /^\d{10,30}$/u.test(suffix) ? "native" : "synthetic";
}

function existingMatchProofs(comment, post) {
  const target = assertRecord(post.raw?.commentTarget ?? {}, "existing.raw.commentTarget");
  const proofs = [];
  const sourceThumbnailFingerprint = nullableString(
    comment.observation?.sourceThumbnailAssetFingerprint,
  );
  if (
    sourceThumbnailFingerprint &&
    sourceThumbnailFingerprint === nullableString(target.contentId)
  ) {
    proofs.push("thumbnail-asset-fingerprint");
  }
  const captureCaption = normalizedCaption(comment.observation?.targetCaption);
  const historicalCaption = existingCaption(post, comment.target.authorHandle);
  if (captureCaption && historicalCaption && captureCaption === historicalCaption) {
    proofs.push("normalized-target-caption");
  }
  const captureShortcode = canonicalShortcode(
    comment.target.url,
    comment.url,
    comment.target.contentId,
  );
  const existingShortcode = canonicalShortcode(target.url, post.url, target.contentId);
  if (captureShortcode && existingShortcode && captureShortcode === existingShortcode) {
    proofs.push("canonical-permalink-shortcode");
  }
  return proofs;
}

export function reconcileCaptureWithExistingHistory(captureValue, historyValue) {
  const capture = assertRecord(captureValue, "capture");
  const history = assertRecord(historyValue, "existingHistory");
  if (!Array.isArray(capture.comments)) throw new Error("capture.comments doit être un tableau.");
  if (!Array.isArray(history.posts)) throw new Error("existingHistory.posts doit être un tableau.");
  const existingComments = history.posts.filter(
    (post) => post?.platform === PLATFORM && post?.format === "comment",
  );
  const pairIndex = new Map();
  for (const post of existingComments) {
    const text = requireString(post.text, "existing.text");
    const target = assertRecord(post.raw?.commentTarget ?? {}, "existing.raw.commentTarget");
    const authorHandle = requireString(target.authorHandle, "existing.target.authorHandle");
    const key = JSON.stringify([text, authorHandle]);
    const rows = pairIndex.get(key) ?? [];
    rows.push(post);
    pairIndex.set(key, rows);
  }

  const claimedExternalIds = new Set();
  const matchedExternalIds = new Set();
  const proofCounts = {
    "thumbnail-asset-fingerprint": 0,
    "normalized-target-caption": 0,
    "canonical-permalink-shortcode": 0,
  };
  const comments = capture.comments.map((commentValue, index) => {
    const comment = assertRecord(commentValue, `capture.comments[${index}]`);
    const authorHandle = requireString(
      comment.target?.authorHandle,
      `capture.comments[${index}].target.authorHandle`,
    );
    const candidates = pairIndex.get(JSON.stringify([comment.text, authorHandle])) ?? [];
    const proven = candidates
      .map((post) => ({ post, proofs: existingMatchProofs(comment, post) }))
      .filter((candidate) => candidate.proofs.length > 0);
    if (proven.length > 1) {
      throw new Error(
        `Raccordement historique ambigu pour capture.comments[${index}] (${proven
          .map((candidate) => candidate.post.externalId)
          .join(", ")}).`,
      );
    }
    if (proven.length === 0) return comment;

    const [{ post, proofs }] = proven;
    const externalId = requireString(post.externalId, "existing.externalId");
    if (!externalId.startsWith("comment:")) {
      throw new Error(`externalId historique Instagram invalide : ${externalId}`);
    }
    if (claimedExternalIds.has(externalId)) {
      throw new Error(`Collision de raccordement historique sur ${externalId}.`);
    }
    claimedExternalIds.add(externalId);
    matchedExternalIds.add(externalId);
    for (const proof of proofs) proofCounts[proof] += 1;
    const suffix = externalId.slice("comment:".length);
    if (!/^[A-Za-z0-9._:-]{1,240}$/u.test(suffix)) {
      throw new Error(`Suffixe externalId historique invalide : ${externalId}`);
    }
    return {
      ...comment,
      id: suffix,
      idKind: existingIdKind(post, suffix),
      observation: {
        ...comment.observation,
        existingHistoryMatch: { externalId, proofs },
      },
    };
  });

  const ids = comments.map((comment) => comment.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Collision d’identifiants après raccordement historique.");
  }
  const unmatchedExistingExternalIds = existingComments
    .map((post) => post.externalId)
    .filter((externalId) => !matchedExternalIds.has(externalId))
    .sort();
  return {
    comments,
    report: {
      provided: true,
      existingInstagramCommentCount: existingComments.length,
      matchedCount: matchedExternalIds.size,
      newCount: comments.length - matchedExternalIds.size,
      unmatchedExistingCount: unmatchedExistingExternalIds.length,
      unmatchedExistingExternalIds,
      proofCounts,
    },
  };
}

function relativeAgeHours(value) {
  const age = requireString(value, "ownComment.age");
  const match = age.match(/^(\d+)([hdw])$/i);
  if (!match) throw new Error(`Âge relatif Instagram non reconnu : ${age}`);
  const multipliers = { h: 1, d: 24, w: 24 * 7 };
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
}

function coverage(covered, total) {
  return {
    covered,
    total,
    percent: total === 0 ? 0 : Number(((covered / total) * 100).toFixed(2)),
  };
}

function honestTitle(card) {
  const targetText = nullableString(card.targetText);
  if (targetText) return targetText;
  const author = nullableString(card.targetAuthor);
  return author
    ? `Publication Instagram de @${author} (texte cible non fourni)`
    : "Publication Instagram (auteur et texte cible non fournis)";
}

function targetFingerprint(card, permalink) {
  if (permalink) return `shortcode:${permalink.shortcode}`;
  const thumbnail = thumbnailFingerprint(card.thumbnailUrl);
  if (thumbnail) return `thumbnail:${thumbnail}`;
  const targetText = nullableString(card.targetText);
  if (targetText) return `target-text:${hash(targetText)}`;
  return `raw-card:${hash(JSON.stringify(card.rawText ?? null))}`;
}

function completionEvidence(scrollLog) {
  if (!Array.isArray(scrollLog)) throw new Error("checkpoint.scrollLog doit être un tableau.");
  const byPassAndIteration = new Map(
    scrollLog.map((entry) => [`${entry.pass}:${entry.iteration}`, entry]),
  );
  const assertStall = (pass, iterations) => {
    const rows = iterations.map((iteration) => byPassAndIteration.get(`${pass}:${iteration}`));
    if (rows.some((row) => !row || row.added !== 0)) {
      throw new Error(`La preuve de fin ${pass} ${iterations.join("-")} est incomplète.`);
    }
    const last = rows.at(-1);
    return {
      pass,
      stallIterations: iterations,
      consecutiveNoGrowth: true,
      finalObservedCardCount: last.total,
      finalVisibleCardCount: last.visible,
      finalScrollTop: last.scrollTop,
      finalScrollHeight: last.scrollHeight,
    };
  };
  const recentDelta = byPassAndIteration.get("newest-delta:22");
  if (!recentDelta) throw new Error("La preuve du delta récent iteration 22 manque.");
  return {
    newest: assertStall("newest", [15, 16, 17]),
    oldest: assertStall("oldest", [19, 20, 21]),
    recentDelta: {
      pass: "newest-delta",
      iteration: 22,
      observedCardCount: recentDelta.visible,
      addedCardCount: recentDelta.added,
      finalCollectedCardCount: recentDelta.total,
      note: recentDelta.note ?? null,
    },
  };
}

function nonNegativeInteger(value, label, fallback = 0) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou nul.`);
  }
  return value;
}

function threadExpansionAssessment(checkpoint, auditValue) {
  const detectedThreadCards = checkpoint.comments.filter(
    (card) => typeof card?.rawText === "string" && /View entire thread/iu.test(card.rawText),
  ).length;
  if (auditValue == null) {
    const complete = detectedThreadCards === 0;
    return {
      inventoryStatus: complete ? "complete" : "partial",
      endReached: complete,
      issues: complete ? [] : ["thread-expansion-audit-missing"],
      audit: {
        provided: false,
        status: complete ? "not-required" : "missing",
        identifiedThreadCards: detectedThreadCards,
        attemptedThreadCards: 0,
        expandedThreadCards: 0,
        failedThreadCards: 0,
        notAttemptedThreadCards: detectedThreadCards,
        newAuthoredComments: 0,
        failure: complete ? null : "Des fils repliés ont été détectés sans audit d’expansion.",
        endReached: complete,
        inventoryStatus: complete ? "complete" : "partial",
      },
    };
  }

  const audit = assertRecord(auditValue, "threadExpansionAudit");
  if (audit.platform !== PLATFORM) {
    throw new Error("threadExpansionAudit.platform doit être instagram.");
  }
  const attemptedAt = requireString(audit.attemptedAt, "threadExpansionAudit.attemptedAt");
  if (!Number.isFinite(Date.parse(attemptedAt))) {
    throw new Error("threadExpansionAudit.attemptedAt doit être une date ISO valide.");
  }
  const inventoryStatus = requireString(
    audit.inventoryStatus,
    "threadExpansionAudit.inventoryStatus",
  );
  if (!['complete', 'partial'].includes(inventoryStatus)) {
    throw new Error("threadExpansionAudit.inventoryStatus doit être complete ou partial.");
  }
  if (typeof audit.endReached !== "boolean") {
    throw new Error("threadExpansionAudit.endReached doit être un booléen.");
  }
  const identifiedThreadCards = nonNegativeInteger(
    audit.identifiedThreadCards,
    "threadExpansionAudit.identifiedThreadCards",
    detectedThreadCards,
  );
  if (identifiedThreadCards !== detectedThreadCards) {
    throw new Error(
      `L’audit identifie ${identifiedThreadCards} fils, mais le checkpoint en contient ${detectedThreadCards}.`,
    );
  }
  const complete =
    identifiedThreadCards === 0 ||
    (inventoryStatus === "complete" && audit.endReached === true);
  const issues = [];
  if (!complete) {
    issues.push("hidden-threads-not-exhausted", "thread-expansion-audit-partial");
  }
  return {
    inventoryStatus: complete ? "complete" : "partial",
    endReached: complete,
    issues,
    audit: {
      provided: true,
      attemptedAt,
      source: nullableString(audit.source),
      status: nullableString(audit.status) ?? inventoryStatus,
      identifiedThreadCards,
      attemptedThreadCards: nonNegativeInteger(
        audit.attemptedThreadCards,
        "threadExpansionAudit.attemptedThreadCards",
      ),
      expandedThreadCards: nonNegativeInteger(
        audit.expandedThreadCards,
        "threadExpansionAudit.expandedThreadCards",
      ),
      failedThreadCards: nonNegativeInteger(
        audit.failedThreadCards,
        "threadExpansionAudit.failedThreadCards",
      ),
      notAttemptedThreadCards: nonNegativeInteger(
        audit.notAttemptedThreadCards,
        "threadExpansionAudit.notAttemptedThreadCards",
      ),
      newAuthoredComments: nonNegativeInteger(
        audit.newAuthoredComments,
        "threadExpansionAudit.newAuthoredComments",
      ),
      failure: nullableString(audit.failure),
      canonicalExportStatus: nullableString(audit.canonicalExportStatus),
      endReached: audit.endReached,
      inventoryStatus,
    },
  };
}

export function normalizeInstagramCheckpoint(
  input,
  { existingHistory = null, threadExpansionAudit = null } = {},
) {
  const checkpoint = assertRecord(input, "checkpoint");
  if (checkpoint.platform !== PLATFORM) throw new Error("Le checkpoint doit être Instagram.");
  const capturedAt = requireString(checkpoint.capturedAt, "checkpoint.capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("checkpoint.capturedAt doit être une date ISO valide.");
  }
  if (!Array.isArray(checkpoint.comments)) {
    throw new Error("checkpoint.comments doit être un tableau.");
  }

  const evidence = completionEvidence(checkpoint.scrollLog);
  const threadExpansion = threadExpansionAssessment(checkpoint, threadExpansionAudit);
  const flattened = [];
  for (const [cardIndex, sourceCard] of checkpoint.comments.entries()) {
    const card = assertRecord(sourceCard, `comments[${cardIndex}]`);
    if (!Array.isArray(card.ownComments) || card.ownComments.length === 0) {
      throw new Error(`comments[${cardIndex}].ownComments doit contenir au moins un commentaire.`);
    }
    const permalink = instagramPermalink(card.url, nullableString(card.shortcode));
    const fingerprint = targetFingerprint(card, permalink);
    for (const [commentIndex, sourceComment] of card.ownComments.entries()) {
      const ownComment = assertRecord(
        sourceComment,
        `comments[${cardIndex}].ownComments[${commentIndex}]`,
      );
      const age = requireString(ownComment.age, "ownComment.age");
      const text = requireString(ownComment.text, "ownComment.text");
      const authorHandle = nullableString(card.targetAuthor);
      const identityKey = JSON.stringify([
        PLATFORM,
        authorHandle?.toLowerCase() ?? null,
        fingerprint,
        text,
        age,
      ]);
      flattened.push({
        card,
        permalink,
        fingerprint,
        age,
        ageHours: relativeAgeHours(age),
        text,
        authorHandle,
        identityKey,
        digest: hash(identityKey),
      });
    }
  }

  const uniqueObservations = new Map();
  for (const item of flattened) {
    if (!uniqueObservations.has(item.identityKey)) {
      uniqueObservations.set(item.identityKey, item);
    }
  }
  const deduplicated = [...uniqueObservations.values()];
  const comments = deduplicated.map((item) => {
    const id = `instagram-synthetic-${item.digest}`;
    const available = item.permalink != null;
    return {
      id,
      idKind: "synthetic",
      ...(available ? { url: item.permalink.url } : {}),
      text: item.text,
      publishedAt: null,
      target: {
        contentId: available ? item.permalink.shortcode : null,
        ...(available ? { url: item.permalink.url } : {}),
        status: available ? "available" : "unavailable",
        unavailable: !available,
        title: honestTitle(item.card),
        thumbnailUrl: nullableString(item.card.thumbnailUrl),
        authorHandle: item.authorHandle,
        authorName: null,
        authorProfileUrl: null,
        audienceValue: null,
        audienceLabel: null,
        audiencePrecision: "unknown",
        audienceObservedAt: null,
      },
      metrics: { likes: null, replies: null },
      observation: {
        relativeAge: item.age,
        targetRelativeAge: nullableString(item.card.targetAge),
        targetFingerprint: item.fingerprint,
        sourceThumbnailAssetFingerprint: thumbnailFingerprint(item.card.thumbnailUrl),
        targetCaption: nullableString(item.card.targetText),
        passes: Array.isArray(item.card.passes) ? item.card.passes : [],
        firstSeenIteration: item.card.firstSeenIteration ?? null,
        lastSeenIteration: item.card.lastSeenIteration ?? null,
      },
    };
  });

  const ids = new Set(comments.map((comment) => comment.id));
  if (ids.size !== comments.length) throw new Error("Collision d’identifiants synthétiques.");

  const ages = deduplicated.map((item) => item.ageHours);
  const oldestIndex = ages.indexOf(Math.max(...ages));
  const newestIndex = ages.indexOf(Math.min(...ages));
  const range = {
    newestRelativeAge: deduplicated[newestIndex]?.age ?? null,
    oldestRelativeAge: deduplicated[oldestIndex]?.age ?? null,
  };
  if (range.newestRelativeAge !== "0h" || range.oldestRelativeAge !== "37w") {
    throw new Error(
      `Plage inattendue : ${range.newestRelativeAge ?? "?"} à ${range.oldestRelativeAge ?? "?"}.`,
    );
  }

  const total = comments.length;
  const baseCapture = {
    platform: PLATFORM,
    capturedAt,
    activitySourceUrl: ACTIVITY_SOURCE_URL,
    comments,
  };
  const reconciliation = existingHistory
    ? reconcileCaptureWithExistingHistory(baseCapture, existingHistory)
    : {
        comments,
        report: {
          provided: false,
          existingInstagramCommentCount: null,
          matchedCount: 0,
          newCount: comments.length,
          unmatchedExistingCount: null,
          unmatchedExistingExternalIds: [],
          proofCounts: {},
        },
      };
  const reconciledNativeIdCount = reconciliation.comments.filter(
    (comment) => comment.idKind === "native",
  ).length;
  const reconciledSyntheticIdCount = reconciliation.comments.length - reconciledNativeIdCount;
  const manifest = {
    platform: PLATFORM,
    capturedAt,
    source: "Instagram · Votre activité · Interactions · Commentaires",
    activitySourceUrl: ACTIVITY_SOURCE_URL,
    sourceCheckpoint: "observations.checkpoint.json",
    inventoryStatus: threadExpansion.inventoryStatus,
    endReached: threadExpansion.endReached,
    issues: threadExpansion.issues,
    recordCount: total,
    rawIndividualObservationCount: flattened.length,
    deduplicatedExactObservationCount: flattened.length - total,
    sourceCardCount: checkpoint.comments.length,
    idKind:
      reconciledNativeIdCount === 0
        ? "synthetic"
        : reconciledSyntheticIdCount === 0
          ? "native"
          : "mixed",
    nativeIdCount: reconciledNativeIdCount,
    syntheticIdCount: reconciledSyntheticIdCount,
    relativeAgeRange: range,
    completionEvidence: evidence,
    threadExpansionAudit: threadExpansion.audit,
    coverage: {
      targetAuthor: coverage(
        comments.filter((comment) => comment.target.authorHandle != null).length,
        total,
      ),
      targetText: coverage(
        deduplicated.filter((item) => nullableString(item.card.targetText) != null).length,
        total,
      ),
      targetThumbnail: coverage(
        comments.filter((comment) => comment.target.thumbnailUrl != null).length,
        total,
      ),
      permalink: coverage(comments.filter((comment) => comment.url != null).length, total),
    },
    identity: {
      algorithm: "sha256",
      keyParts: [
        "platform",
        "targetAuthor",
        "targetFingerprint",
        "commentTextExact",
        "relativeAge",
      ],
      targetFingerprintPriority: ["instagramShortcode", "thumbnailPath", "targetText", "rawCard"],
      duplicateOrdinalApplied: 0,
      deduplication: "exact-observation-identity-before-id-assignment",
      uniqueIdCount: ids.size,
    },
    existingHistoryReconciliation: reconciliation.report,
  };

  return {
    manifest,
    capture: {
      platform: PLATFORM,
      capturedAt,
      activitySourceUrl: ACTIVITY_SOURCE_URL,
      inventory: {
        inventoryStatus: manifest.inventoryStatus,
        endReached: manifest.endReached,
        issues: manifest.issues,
        recordCount: manifest.recordCount,
        relativeAgeRange: manifest.relativeAgeRange,
        completionEvidence: manifest.completionEvidence,
        threadExpansionAudit: manifest.threadExpansionAudit,
        coverage: manifest.coverage,
        existingHistoryReconciliation: reconciliation.report,
      },
      comments: reconciliation.comments,
    },
  };
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function parseOptions(argv) {
  const options = {
    input: DEFAULT_INPUT,
    outputDirectory: null,
    existingHistory: null,
    threadExpansionAudit: null,
  };
  for (const argument of argv) {
    if (argument.startsWith("--input=")) {
      options.input = resolve(argument.slice("--input=".length));
    }
    else if (argument.startsWith("--output-directory=")) {
      options.outputDirectory = resolve(argument.slice("--output-directory=".length));
    } else if (argument.startsWith("--existing-history=")) {
      options.existingHistory = resolve(argument.slice("--existing-history=".length));
    } else if (argument.startsWith("--thread-expansion-audit=")) {
      options.threadExpansionAudit = resolve(
        argument.slice("--thread-expansion-audit=".length),
      );
    } else throw new Error(`Argument inconnu : ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [checkpoint, existingHistory, threadExpansionAudit] = await Promise.all([
    readFile(options.input, "utf8").then(JSON.parse),
    options.existingHistory
      ? readFile(options.existingHistory, "utf8").then(JSON.parse)
      : Promise.resolve(null),
    options.threadExpansionAudit
      ? readFile(options.threadExpansionAudit, "utf8").then(JSON.parse)
      : Promise.resolve(null),
  ]);
  const { manifest, capture } = normalizeInstagramCheckpoint(checkpoint, {
    existingHistory,
    threadExpansionAudit,
  });
  const outputDirectory = options.outputDirectory ?? dirname(options.input);
  const manifestPath = resolve(outputDirectory, "inventory-manifest.json");
  const capturePath = resolve(outputDirectory, "normalized-capture.json");
  await Promise.all([
    writeJsonAtomically(manifestPath, manifest),
    writeJsonAtomically(capturePath, capture),
  ]);
  process.stdout.write(`${JSON.stringify({ manifestPath, capturePath, ...manifest }, null, 2)}\n`);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  await main();
}

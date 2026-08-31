import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkTrendFeedsHealth,
  evaluateTrendHealth,
  validateDiscoveryAudit,
  validateVisibleRotationAudit,
} from "../scripts/check-trends-health.mjs";
import {
  buildTrendHealthDiscordMessage,
  decideTrendHealthNotification,
  notifyTrendHealth,
} from "../scripts/notify-trends-health.mjs";
import { isTrendEditorialScanLate } from "../lib/trend-health.ts";

const checkedAt = "2026-08-21T12:00:00.000Z";
const freshCapturedAt = "2026-08-21T10:00:00.000Z";

function healthyVideoStatus() {
  return {
    status: "success",
    discoveryAudit: {
      scannedAt: freshCapturedAt,
      complete: true,
      candidateCount: 72,
      qualifiedInventoryCount: 55,
      added: 17,
      removed: 3,
      retained: 55,
      newQualifiedCount: 0,
      newQualifiedTrendIds: [],
      removedTrendCount: 0,
      removedTrendIds: [],
      retainedQualifiedTrendIds: inventory().map((trend) => trend.id),
      noRotationReason: "Tous les candidats ont été classés; aucun nouveau cluster ne dépasse le cutoff top 50.",
      lastVisibleRotationAt: freshCapturedAt,
      visibleAddedCount: 0,
      visibleRemovedCount: 0,
      unchangedRunCount: 1,
    },
  };
}

function healthyAudioStatus() {
  return {
    status: "success",
    published: true,
    discoveryAudit: {
      scannedAt: freshCapturedAt,
      complete: true,
      candidateCount: 68,
      qualifiedInventoryCount: 3,
      qualifiedClusterCount: 3,
      publishedInventoryCount: 50,
      qualificationAudit: { freshQualifiedCount: 3 },
      candidatePoolDelta: { added: 8, removed: 2, retained: 60 },
      lastVisibleRotationAt: freshCapturedAt,
      visibleAddedCount: 0,
      visibleRemovedCount: 0,
      unchangedRunCount: 1,
      selectionAudit: {
        evaluatedAt: freshCapturedAt,
        addedTrendIds: [],
        removedTrendIds: [],
        retainedTrendIds: inventory(50).map((trend) => trend.id),
        noRotationReason: "Les trois clusters frais ne dépassent pas la dernière carte conservée.",
      },
    },
  };
}

function inventory(count = 55) {
  return Array.from({ length: count }, (_value, index) => ({ id: `trend-${index}` }));
}

function alertReport({
  checkedAt: reportCheckedAt = checkedAt,
  healthy = false,
  audioIssues = ["discoveryAudit incomplet", "feed.capturedAt dépasse 26 h"],
} = {}) {
  return {
    checkedAt: reportCheckedAt,
    healthy,
    results: [
      {
        key: "video",
        label: "Trends vidéos",
        healthy,
        capturedAt: freshCapturedAt,
        discoveryScannedAt: freshCapturedAt,
        candidateCount: 72,
        qualifiedInventoryCount: 55,
        qualifiedClusterCount: null,
        publishedInventoryCount: 55,
        feedInventoryCount: 55,
        candidatePoolChanges: { added: 17, removed: 3, retained: 55, changed: true },
        selectionChanges: {
          added: 0,
          removed: 0,
          retained: 55,
          changed: false,
          noRotationReason: "Aucun nouveau cluster ne dépasse le cutoff.",
        },
        issues: healthy ? [] : ["feed.capturedAt dépasse 26 h"],
      },
      {
        key: "audio",
        label: "Trends audio",
        healthy,
        capturedAt: freshCapturedAt,
        discoveryScannedAt: freshCapturedAt,
        candidateCount: 68,
        qualifiedInventoryCount: 3,
        qualifiedClusterCount: 3,
        publishedInventoryCount: 50,
        feedInventoryCount: 50,
        candidatePoolChanges: { added: 8, removed: 2, retained: 60, changed: true },
        selectionChanges: {
          added: 0,
          removed: 0,
          retained: 50,
          changed: false,
          noRotationReason: "Aucun cluster frais ne dépasse la dernière carte.",
        },
        issues: healthy ? [] : audioIssues,
      },
    ],
  };
}

test("editorial scan freshness turns late strictly after 26 hours", () => {
  assert.equal(
    isTrendEditorialScanLate("2026-08-20T10:00:00.000Z", checkedAt),
    false,
  );
  assert.equal(
    isTrendEditorialScanLate("2026-08-20T09:59:59.999Z", checkedAt),
    true,
  );
  assert.equal(isTrendEditorialScanLate("invalid", checkedAt), true);
});

test("video health requires a recent discovery audit and 50 qualified published trends", () => {
  assert.deepEqual(validateDiscoveryAudit(healthyVideoStatus().discoveryAudit, checkedAt), []);
  assert.match(validateDiscoveryAudit(null, checkedAt).join(" "), /absent/i);
  assert.match(
    validateDiscoveryAudit({
      scannedAt: "2026-08-19T00:00:00.000Z",
      complete: false,
      candidateCount: 49,
      qualifiedInventoryCount: 49,
      added: 0,
      removed: 0,
      retained: 49,
    }, checkedAt).join(" "),
    /incomplet.*dépasse 26 h.*candidateCount.*qualifiedInventoryCount/i,
  );
});

test("asset-only refreshes cannot make a trend feed healthy", () => {
  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: {
      status: "degraded",
      published: true,
      coverage: { thumbnailPublishable: true },
    },
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /discoveryAudit absent/i);
});

test("fresh feed and complete discovery audit are healthy", () => {
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: healthyVideoStatus(),
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.candidatePoolChanges, {
    added: 17,
    removed: 3,
    retained: 55,
    changed: true,
  });
});

test("video and audio health fail closed when the visible rotation audit is absent", () => {
  for (const [key, status, count] of [
    ["video", healthyVideoStatus(), 55],
    ["audio", healthyAudioStatus(), 50],
  ]) {
    delete status.discoveryAudit.lastVisibleRotationAt;
    delete status.discoveryAudit.visibleAddedCount;
    delete status.discoveryAudit.visibleRemovedCount;
    delete status.discoveryAudit.unchangedRunCount;
    const result = evaluateTrendHealth({
      key,
      label: key === "audio" ? "Trends audio" : "Trends vidéos",
      feed: { capturedAt: freshCapturedAt, trends: inventory(count) },
      status,
    }, checkedAt);
    assert.equal(result.healthy, false);
    assert.match(result.issues.join(" "), /audit de rotation visible absent/i);
  }
});

test("the last real visible rotation must be no more than 26 hours old", () => {
  const exactlyAtLimit = healthyVideoStatus().discoveryAudit;
  exactlyAtLimit.lastVisibleRotationAt = "2026-08-20T10:00:00.000Z";
  assert.deepEqual(
    validateVisibleRotationAudit(exactlyAtLimit, checkedAt, {
      key: "video",
      selection: { added: 0, removed: 0 },
    }).issues,
    [],
  );

  const stale = healthyVideoStatus().discoveryAudit;
  stale.lastVisibleRotationAt = "2026-08-20T09:59:59.999Z";
  assert.match(
    validateVisibleRotationAudit(stale, checkedAt, {
      key: "video",
      selection: { added: 0, removed: 0 },
    }).issues.join(" "),
    /dernière rotation visible dépasse 26 h/i,
  );
});

test("an incomplete visible rotation audit names every missing proof field", () => {
  const audit = healthyVideoStatus().discoveryAudit;
  delete audit.visibleRemovedCount;
  const result = validateVisibleRotationAudit(audit, checkedAt, {
    key: "video",
    selection: { added: 0, removed: 0 },
  });
  assert.match(
    result.issues.join(" "),
    /audit de rotation visible incomplet: visibleRemovedCount absent/i,
  );
});

test("audio accepts its visible rotation audit from selectionAudit as a compatibility fallback", () => {
  const status = healthyAudioStatus();
  const fields = {
    lastVisibleRotationAt: status.discoveryAudit.lastVisibleRotationAt,
    visibleAddedCount: status.discoveryAudit.visibleAddedCount,
    visibleRemovedCount: status.discoveryAudit.visibleRemovedCount,
    unchangedRunCount: status.discoveryAudit.unchangedRunCount,
  };
  for (const field of Object.keys(fields)) delete status.discoveryAudit[field];
  Object.assign(status.discoveryAudit.selectionAudit, fields);

  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory(50) },
    status,
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.equal(result.visibleRotation?.source, "selectionAudit");
});

test("visible rotation counters must match the published selection and unchanged-run state", () => {
  const status = healthyAudioStatus();
  status.discoveryAudit.visibleAddedCount = 1;
  status.discoveryAudit.visibleRemovedCount = 0;
  status.discoveryAudit.unchangedRunCount = 2;
  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory(50) },
    status,
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /nombre ajouté.*nombre retiré/i);
  assert.match(result.issues.join(" "), /compteurs de rotation visible.*sélection publiée/i);
  assert.match(result.issues.join(" "), /unchangedRunCount.*passage courant/i);
});

test("video inventory may grow toward its target without inventing a removal", () => {
  const status = healthyVideoStatus();
  status.discoveryAudit.qualifiedInventoryCount = 56;
  status.discoveryAudit.newQualifiedCount = 1;
  status.discoveryAudit.newQualifiedTrendIds = ["trend-55"];
  status.discoveryAudit.noRotationReason = null;
  status.discoveryAudit.visibleAddedCount = 1;
  status.discoveryAudit.visibleRemovedCount = 0;
  status.discoveryAudit.unchangedRunCount = 0;
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory(56) },
    status,
  }, checkedAt);
  assert.equal(result.healthy, true);
});

test("a candidate scan cannot impersonate the qualified published feed", () => {
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: {
      ...healthyVideoStatus(),
      status: "degraded",
      discoveryAudit: {
        ...healthyVideoStatus().discoveryAudit,
        scannedAt: "2026-08-21T11:00:00.000Z",
      },
    },
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(
    result.issues.join(" "),
    /refresh vidéo n'a pas le statut success.*capturedAt ne correspond pas au scan qualifié publié/i,
  );
});

test("an unchanged but fully qualified candidate pool remains honest and healthy", () => {
  const status = healthyVideoStatus();
  status.discoveryAudit = {
    ...status.discoveryAudit,
    candidateCount: 55,
    added: 0,
    removed: 0,
    retained: 55,
  };
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status,
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.equal(result.candidatePoolChanges?.changed, false);
});

test("candidate pool deltas must reconcile with the audited candidate count", () => {
  const status = healthyVideoStatus();
  status.discoveryAudit = {
    ...status.discoveryAudit,
    candidateCount: 70,
  };
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status,
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /added \+ retained.*candidateCount/i);
});

test("audio health accepts three fresh qualified clusters backed by a 50-card publication", () => {
  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory(50) },
    status: healthyAudioStatus(),
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.equal(result.qualifiedClusterCount, 3);
  assert.equal(result.publishedInventoryCount, 50);
  assert.deepEqual(result.candidatePoolChanges, {
    added: 8,
    removed: 2,
    retained: 60,
    changed: true,
  });
});

test("audio health rejects fewer than three fresh clusters, a fake inventory count, or unpublished status", () => {
  const status = healthyAudioStatus();
  status.status = "degraded";
  status.published = false;
  status.discoveryAudit.qualifiedClusterCount = 2;
  status.discoveryAudit.qualificationAudit.freshQualifiedCount = 2;
  status.discoveryAudit.publishedInventoryCount = 49;
  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory(50) },
    status,
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /qualifiedClusterCount doit être >= 3/i);
  assert.match(result.issues.join(" "), /publishedInventoryCount doit être >= 50/i);
  assert.match(result.issues.join(" "), /statut success/i);
  assert.match(result.issues.join(" "), /n'est pas publié/i);
});

test("zero rotation must carry a verifiable reason for video and audio", () => {
  const videoStatus = healthyVideoStatus();
  videoStatus.discoveryAudit.noRotationReason = null;
  const video = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: videoStatus,
  }, checkedAt);
  assert.equal(video.healthy, false);
  assert.match(video.issues.join(" "), /rotation nulle sans noRotationReason/i);

  const audioStatus = healthyAudioStatus();
  audioStatus.discoveryAudit.selectionAudit.noRotationReason = "";
  const audio = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory(50) },
    status: audioStatus,
  }, checkedAt);
  assert.equal(audio.healthy, false);
  assert.match(audio.issues.join(" "), /selectionAudit absent ou invalide/i);
});

test("missing or corrupt JSON returns a detailed unhealthy report instead of throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trends-health-json-"));
  const missingFeedPath = join(directory, "missing-feed.json");
  const corruptStatusPath = join(directory, "refresh-status.json");
  try {
    await writeFile(corruptStatusPath, "{not-json", "utf8");
    const report = await checkTrendFeedsHealth({
      checkedAt,
      sources: [{
        key: "video",
        label: "Trends vidéos test",
        feedPath: missingFeedPath,
        statusPath: corruptStatusPath,
      }],
    });
    assert.equal(report.healthy, false);
    assert.equal(report.results.length, 1);
    assert.match(report.results[0].issues.join(" "), /feed JSON absent.*missing-feed\.json/i);
    assert.match(
      report.results[0].issues.join(" "),
      /refresh-status JSON illisible ou corrompu.*refresh-status\.json/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trend health alerts are deduplicated, reminded after 24 hours, and reopened on a new issue", () => {
  const report = alertReport();
  const first = decideTrendHealthNotification(report, null);
  assert.equal(first?.kind, "incident");

  const incidentState = {
    version: 1,
    status: "unhealthy",
    incidentSignature: first.signature,
    incidentStartedAt: "2026-08-21T11:00:00.000Z",
    alertedForIncident: true,
    lastNotificationAt: "2026-08-21T11:30:00.000Z",
  };
  assert.equal(decideTrendHealthNotification(report, incidentState), null);

  const reminderReport = alertReport({ checkedAt: "2026-08-22T11:30:00.000Z" });
  assert.equal(decideTrendHealthNotification(reminderReport, incidentState)?.kind, "reminder");

  const changedReport = alertReport({ audioIssues: ["le refresh audio n'est pas publié"] });
  assert.equal(decideTrendHealthNotification(changedReport, incidentState)?.kind, "incident");
});

test("a recovery is announced only after an incident was actually announced", () => {
  const healthyReport = alertReport({ healthy: true });
  assert.equal(decideTrendHealthNotification(healthyReport, {
    status: "unhealthy",
    alertedForIncident: false,
  }), null);
  assert.equal(decideTrendHealthNotification(healthyReport, {
    status: "unhealthy",
    alertedForIncident: true,
  })?.kind, "recovery");
  assert.equal(decideTrendHealthNotification(healthyReport, {
    status: "healthy",
    pendingRecovery: true,
  })?.kind, "recovery");
});

test("the Discord alert details both video and audio health without mentions", () => {
  const report = alertReport();
  const payload = buildTrendHealthDiscordMessage(report, { kind: "incident" });
  assert.equal(payload.allowed_mentions.parse.length, 0);
  assert.match(payload.content, /non opérationnelles/i);
  assert.deepEqual(payload.embeds.map((embed) => embed.title), ["Trends vidéos", "Trends audio"]);
  assert.match(payload.embeds[1].description, /discoveryAudit incomplet/i);
  assert.match(payload.embeds[1].fields[1].value, /68 candidats.*3 clusters frais.*50 publiés/i);
  assert.match(payload.embeds[1].fields[2].value, /\+8.*-2.*60 retenus/i);
  assert.match(payload.embeds[1].fields[3].value, /Aucune.*dernière carte/i);
});

test("a mixed incident keeps the healthy feed green and the unhealthy feed red", () => {
  const report = alertReport();
  report.results[0].healthy = true;
  report.results[0].issues = [];
  const payload = buildTrendHealthDiscordMessage(report, { kind: "incident" });
  assert.match(payload.content, /partiellement opérationnelles/i);
  assert.equal(payload.embeds[0].color, 0x22c55e);
  assert.equal(payload.embeds[1].color, 0xef4444);
});

test("an incident is sent once, persisted, suppressed, then followed by one recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trends-health-alert-"));
  const statePath = join(directory, "state.json");
  const payloads = [];
  const fetchImpl = async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    return { ok: true, status: 204 };
  };
  try {
    const first = await notifyTrendHealth({
      report: alertReport(),
      statePath,
      webhookUrl: "https://discord.example/webhook",
      fetchImpl,
      log: () => {},
    });
    assert.equal(first.decision, "incident");
    assert.equal(first.sent, true);

    const duplicate = await notifyTrendHealth({
      report: alertReport(),
      statePath,
      webhookUrl: "https://discord.example/webhook",
      fetchImpl,
      log: () => {},
    });
    assert.equal(duplicate.decision, null);
    assert.equal(duplicate.sent, false);

    const recovery = await notifyTrendHealth({
      report: alertReport({ healthy: true, checkedAt: "2026-08-21T13:00:00.000Z" }),
      statePath,
      webhookUrl: "https://discord.example/webhook",
      fetchImpl,
      log: () => {},
    });
    assert.equal(recovery.decision, "recovery");
    assert.equal(recovery.sent, true);
    assert.equal(payloads.length, 2);
    assert.match(payloads[1].content, /à nouveau opérationnelles/i);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "healthy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing webhook never marks an incident as announced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trends-health-no-webhook-"));
  const statePath = join(directory, "state.json");
  try {
    const skipped = await notifyTrendHealth({
      report: alertReport(),
      statePath,
      webhookUrl: "",
      log: () => {},
    });
    assert.equal(skipped.configured, false);
    assert.equal(skipped.sent, false);
    assert.equal(skipped.state.alertedForIncident, false);

    let calls = 0;
    const retried = await notifyTrendHealth({
      report: alertReport(),
      statePath,
      webhookUrl: "https://discord.example/webhook",
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 204 };
      },
      log: () => {},
    });
    assert.equal(retried.decision, "incident");
    assert.equal(retried.sent, true);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the scheduled health workflow persists alert state and still fails closed", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/social-check-trends-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /DISCORD_CM_WEBHOOK_URL: \$\{\{ secrets\.DISCORD_CM_WEBHOOK_URL \}\}/);
  assert.match(workflow, /actions\/cache\/restore@v4/);
  assert.match(workflow, /actions\/cache\/save@v4/);
  assert.match(workflow, /scripts\/notify-trends-health\.mjs/);
  assert.match(workflow, /steps\.alert\.outputs\.healthy != 'true'/);
  assert.match(workflow, /run: exit 1/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /contents: write|git push/);
});

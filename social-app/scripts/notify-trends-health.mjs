import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkTrendFeedsHealth } from "./check-trends-health.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALERT_STATE_VERSION = 1;
const DEFAULT_REMINDER_HOURS = 24;
const DEFAULT_STATE_PATH = resolve(root, "work", "trends-health-alert-state.json");

function safeIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function buildTrendHealthIncidentSignature(report) {
  const incident = report.results
    .filter((result) => !result.healthy)
    .map((result) => ({
      key: result.key,
      issues: [...result.issues].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return createHash("sha256").update(JSON.stringify(incident)).digest("hex").slice(0, 20);
}

export function decideTrendHealthNotification(
  report,
  previousState,
  { reminderHours = DEFAULT_REMINDER_HOURS } = {},
) {
  if (!Number.isFinite(Date.parse(report.checkedAt))) {
    throw new Error("Horodatage du rapport Trends invalide.");
  }
  if (!Number.isFinite(reminderHours) || reminderHours <= 0) {
    throw new Error("Fréquence de rappel Trends invalide.");
  }

  if (report.healthy) {
    const recoveryPending = previousState?.pendingRecovery === true ||
      (previousState?.status === "unhealthy" && previousState?.alertedForIncident === true);
    return recoveryPending ? { kind: "recovery", signature: null } : null;
  }

  const signature = buildTrendHealthIncidentSignature(report);
  const sameIncident = previousState?.status === "unhealthy" &&
    previousState?.incidentSignature === signature;
  if (!sameIncident || previousState?.alertedForIncident !== true) {
    return { kind: "incident", signature };
  }

  const lastNotificationAt = safeIso(previousState?.lastNotificationAt);
  if (!lastNotificationAt) return { kind: "reminder", signature };
  const elapsedHours = (Date.parse(report.checkedAt) - Date.parse(lastNotificationAt)) / 3_600_000;
  return elapsedHours >= reminderHours ? { kind: "reminder", signature } : null;
}

function formatAge(observedAt, checkedAt) {
  const observed = safeIso(observedAt);
  if (!observed) return "inconnu";
  const milliseconds = Math.max(0, Date.parse(checkedAt) - Date.parse(observed));
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, "0")}`;
}

function formatCount(value) {
  return nonNegativeInteger(value) === null ? "?" : String(value);
}

function buildResultEmbed(result, checkedAt, healthy) {
  const pool = result.candidatePoolChanges;
  const poolLabel = pool
    ? `+${pool.added} / -${pool.removed} / ${pool.retained} retenus`
    : "non documentée";
  const selection = result.selectionChanges;
  const selectionLabel = selection
    ? selection.changed
      ? `+${selection.added} / -${selection.removed} · ${selection.retained} conservés`
      : `Aucune · ${selection.noRotationReason}`
    : "non documentée";
  const observedAt = result.discoveryScannedAt ?? result.capturedAt;
  const description = healthy
    ? "Scan éditorial complet, qualifié et publié dans la fenêtre de 26 heures."
    : result.issues.map((issue) => `• ${issue}`).join("\n").slice(0, 3_900);

  return {
    title: result.label,
    color: healthy ? 0x22c55e : 0xef4444,
    description,
    fields: [
      {
        name: "Dernier scan qualifié",
        value: observedAt ? `${observedAt}\nÂge : ${formatAge(observedAt, checkedAt)}` : "Absent",
        inline: true,
      },
      {
        name: "Couverture",
        value: result.key === "audio"
          ? `${formatCount(result.candidateCount)} candidats · ` +
            `${formatCount(result.qualifiedClusterCount)} clusters frais · ` +
            `${formatCount(result.publishedInventoryCount)} publiés`
          : `${formatCount(result.candidateCount)} candidats · ` +
            `${formatCount(result.qualifiedInventoryCount)} qualifiés · ` +
            `${formatCount(result.feedInventoryCount)} publiés`,
        inline: true,
      },
      {
        name: "Pool de candidats",
        value: poolLabel,
        inline: true,
      },
      {
        name: "Rotation publiée",
        value: selectionLabel.slice(0, 1_024),
        inline: false,
      },
    ],
  };
}

export function buildTrendHealthDiscordMessage(report, decision, previousState = null, runUrl = "") {
  const recovery = decision.kind === "recovery";
  const mixedHealth = !report.healthy && report.results.some((result) => result.healthy);
  const title = recovery
    ? "✅ Trends à nouveau opérationnelles"
    : decision.kind === "reminder"
      ? "🚨 Trends toujours obsolètes"
      : mixedHealth
        ? "⚠️ Trends partiellement opérationnelles"
        : "🚨 Trends non opérationnelles";
  const incidentStartedAt = safeIso(
    previousState?.incidentStartedAt ?? previousState?.recoveryIncidentStartedAt,
  );
  const duration = recovery && incidentStartedAt
    ? ` Incident ouvert pendant ${formatAge(incidentStartedAt, report.checkedAt)}.`
    : "";
  const validRunUrl = /^https:\/\//i.test(runUrl) ? runUrl : undefined;
  const embeds = report.results.map((result) => ({
    ...buildResultEmbed(result, report.checkedAt, result.healthy),
    url: validRunUrl,
  }));
  if (embeds[0]) {
    embeds[0].footer = {
      text: recovery
        ? `Récupération confirmée à ${report.checkedAt}.${duration}`
        : `Contrôle fail-closed à ${report.checkedAt} · rappel au plus toutes les 24 h`,
    };
  }
  return {
    allowed_mentions: { parse: [] },
    content: title,
    embeds,
  };
}

async function readAlertState(path, log) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.version === ALERT_STATE_VERSION ? value : null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log("État d'alerte Trends illisible : un nouvel incident sera traité sans déduplication.");
    }
    return null;
  }
}

function nextAlertState(report, previousState, decision, sent) {
  if (!report.healthy) {
    const signature = buildTrendHealthIncidentSignature(report);
    const sameIncident = previousState?.status === "unhealthy" &&
      previousState?.incidentSignature === signature;
    return {
      version: ALERT_STATE_VERSION,
      status: "unhealthy",
      evaluatedAt: report.checkedAt,
      incidentSignature: signature,
      incidentStartedAt: sameIncident
        ? safeIso(previousState?.incidentStartedAt) ?? report.checkedAt
        : report.checkedAt,
      alertedForIncident: sent || (sameIncident && previousState?.alertedForIncident === true),
      lastNotificationAt: sent
        ? report.checkedAt
        : sameIncident
          ? safeIso(previousState?.lastNotificationAt)
          : null,
      pendingRecovery: false,
      recoveryIncidentStartedAt: null,
    };
  }

  const recoveryWasNeeded = decision?.kind === "recovery";
  return {
    version: ALERT_STATE_VERSION,
    status: "healthy",
    evaluatedAt: report.checkedAt,
    incidentSignature: null,
    incidentStartedAt: null,
    alertedForIncident: false,
    lastNotificationAt: sent ? report.checkedAt : safeIso(previousState?.lastNotificationAt),
    pendingRecovery: recoveryWasNeeded && !sent,
    recoveryIncidentStartedAt: recoveryWasNeeded && !sent
      ? safeIso(previousState?.incidentStartedAt ?? previousState?.recoveryIncidentStartedAt)
      : null,
  };
}

async function writeAlertState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function notifyTrendHealth(options = {}) {
  const checkedAt = options.checkedAt ?? options.report?.checkedAt ?? new Date().toISOString();
  const report = options.report ?? await checkTrendFeedsHealth({ checkedAt });
  const webhookUrl = options.webhookUrl ?? process.env.DISCORD_CM_WEBHOOK_URL ?? "";
  const statePath = options.statePath ?? process.env.TRENDS_HEALTH_ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message) => console.log(message));
  const reminderHours = options.reminderHours ?? Number(
    process.env.TRENDS_HEALTH_REMINDER_HOURS ?? DEFAULT_REMINDER_HOURS,
  );
  const previousState = await readAlertState(statePath, log);
  const decision = decideTrendHealthNotification(report, previousState, { reminderHours });

  let sent = false;
  if (decision && !webhookUrl) {
    log(`Alerte Trends ${decision.kind} prête, mais DISCORD_CM_WEBHOOK_URL n'est pas configuré.`);
  } else if (decision) {
    const payload = buildTrendHealthDiscordMessage(
      report,
      decision,
      previousState,
      options.runUrl ?? process.env.TRENDS_HEALTH_RUN_URL ?? "",
    );
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Discord a refusé l'alerte Trends (HTTP ${response.status}).`);
    }
    sent = true;
    log(`Alerte Trends envoyée : ${decision.kind}.`);
  } else {
    log(report.healthy
      ? "Trends saines, aucune notification nécessaire."
      : "Incident Trends inchangé, notification dédupliquée.");
  }

  const state = nextAlertState(report, previousState, decision, sent);
  await writeAlertState(statePath, state);
  return {
    healthy: report.healthy,
    configured: webhookUrl.length > 0,
    decision: decision?.kind ?? null,
    sent,
    state,
    report,
  };
}

async function main() {
  const checkedAt = process.env.TRENDS_HEALTH_NOW ?? new Date().toISOString();
  const result = await notifyTrendHealth({ checkedAt });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `healthy=${result.healthy}\nnotification=${result.decision ?? "none"}\nsent=${result.sent}\n`,
      "utf8",
    );
  }
  for (const item of result.report.results) {
    const prefix = item.healthy ? "OK" : "FAIL";
    console.log(`${prefix} ${item.label}: ${item.issues.join("; ") || "scan éditorial à jour"}.`);
  }
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) await main();

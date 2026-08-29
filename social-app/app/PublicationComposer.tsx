"use client";

/* eslint-disable @next/next/no-img-element -- platform marks are local static assets. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ScheduledIdea } from "../lib/editorial-workflow";
import {
  EMPTY_PUBLICATION_QUEUE,
  PUBLICATION_STORAGE_KEY,
  approvePublicationPlan,
  findPublicationScheduleCollision,
  markPublicationPlanScheduled,
  mergeScheduledIdeasIntoPublicationQueue,
  normalizePublicationQueue,
  publicationReadinessIssues,
  revokePublicationPlan,
  sortedPublicationPlans,
  updatePublicationPlan,
  type PublicationPlan,
  type PublicationPlanPatch,
  type PublicationPlanStatus,
  type PublicationQueueState,
} from "../lib/social-publication";
import type { SocialPlatform } from "../lib/social-scanner";

const PLATFORM_ORDER: SocialPlatform[] = ["youtube", "instagram", "tiktok", "x"];
const PUBLICATION_MUTATION_LOCK = `${PUBLICATION_STORAGE_KEY}:mutation`;
const PLATFORM_META: Record<SocialPlatform, { label: string; openUrl: string }> = {
  youtube: { label: "YouTube", openUrl: "https://studio.youtube.com/" },
  instagram: { label: "Instagram", openUrl: "https://www.instagram.com/" },
  tiktok: { label: "TikTok", openUrl: "https://www.tiktok.com/creator-center/" },
  x: { label: "X", openUrl: "https://x.com/compose/post" },
};

type PublicationFilter = PublicationPlanStatus;

export type LocalPublicationScheduleEntry = {
  ideaId: string;
  publishAtLocal: string;
  platforms: SocialPlatform[];
  caption: string;
};

function readPublicationStorage(): {
  queue: PublicationQueueState;
  recoveredCorruption: boolean;
} {
  const raw = window.localStorage.getItem(PUBLICATION_STORAGE_KEY);
  if (!raw) return { queue: EMPTY_PUBLICATION_QUEUE, recoveredCorruption: false };
  try {
    return {
      queue: normalizePublicationQueue(JSON.parse(raw)),
      recoveredCorruption: false,
    };
  } catch {
    window.localStorage.removeItem(PUBLICATION_STORAGE_KEY);
    return { queue: EMPTY_PUBLICATION_QUEUE, recoveredCorruption: true };
  }
}

function samePublicationSnapshot(left: PublicationPlan, right: PublicationPlan): boolean {
  return left.sourceScheduleFingerprint === right.sourceScheduleFingerprint &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.approvedRevision === right.approvedRevision &&
    left.caption === right.caption &&
    left.mediaUrl === right.mediaUrl &&
    left.publishAtLocal === right.publishAtLocal &&
    left.platforms.join(",") === right.platforms.join(",");
}

async function withPublicationMutationLock<T>(action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks) {
    throw new Error("Le verrou multi-onglets n’est pas disponible dans ce navigateur.");
  }
  return navigator.locks.request(
    PUBLICATION_MUTATION_LOCK,
    { mode: "exclusive" },
    async () => action(),
  );
}

export function PublicationComposer({
  schedule,
  syncing,
  workflowReady,
  workflowAvailable,
  onScheduledPlansChange,
  onStorageAvailabilityChange,
  onRetryWorkflow,
  onOpenRecommendations,
}: {
  schedule: ScheduledIdea[];
  syncing: boolean;
  workflowReady: boolean;
  workflowAvailable: boolean;
  onScheduledPlansChange: (plans: LocalPublicationScheduleEntry[]) => void;
  onStorageAvailabilityChange: (available: boolean) => void;
  onRetryWorkflow: () => void;
  onOpenRecommendations: () => void;
}) {
  const [queue, setQueue] = useState<PublicationQueueState>(EMPTY_PUBLICATION_QUEUE);
  const [storageReady, setStorageReady] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [mutationLockAvailable, setMutationLockAvailable] = useState(true);
  const [pendingIdeaId, setPendingIdeaId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PublicationFilter>("draft");
  const [notice, setNotice] = useState("");
  const scheduleRevision = useMemo(
    () => JSON.stringify(schedule.map((item) => [item.ideaId, item.updatedAt, item.status])),
    [schedule],
  );
  const reconciledScheduleRevisionRef = useRef("");
  const transitionPendingRef = useRef(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let nextQueue = EMPTY_PUBLICATION_QUEUE;
      let available = true;
      const lockAvailable = Boolean(navigator.locks);
      try {
        const probeKey = `${PUBLICATION_STORAGE_KEY}:probe`;
        window.localStorage.setItem(probeKey, "1");
        window.localStorage.removeItem(probeKey);
        const saved = readPublicationStorage();
        nextQueue = saved.queue;
        if (saved.recoveredCorruption) {
          setNotice("Sauvegarde locale endommagée réinitialisée sans autoriser de publication.");
        }
      } catch {
        available = false;
      }
      setQueue(nextQueue);
      setStorageAvailable(available);
      setMutationLockAvailable(lockAvailable);
      if (!lockAvailable) {
        setNotice("Verrou multi-onglets indisponible : la file reste en lecture seule.");
      }
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PUBLICATION_STORAGE_KEY) return;
      try {
        const saved = readPublicationStorage();
        setQueue(saved.queue);
        setStorageAvailable(true);
        if (saved.recoveredCorruption) {
          setNotice("Sauvegarde locale endommagée réinitialisée.");
        }
      } catch {
        setStorageAvailable(false);
        setNotice("Stockage local indisponible : la file passe en lecture seule.");
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const mergedQueue = useMemo(
    () => workflowReady && workflowAvailable
      ? mergeScheduledIdeasIntoPublicationQueue(schedule, queue)
      : queue,
    [queue, schedule, workflowAvailable, workflowReady],
  );

  useEffect(() => {
    if (
      !workflowReady ||
      !workflowAvailable ||
      syncing ||
      !storageReady ||
      !storageAvailable ||
      !mutationLockAvailable
    ) {
      return;
    }
    if (reconciledScheduleRevisionRef.current === scheduleRevision) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void withPublicationMutationLock(() => {
        if (cancelled) return null;
        const latest = readPublicationStorage().queue;
        const reconciled = mergeScheduledIdeasIntoPublicationQueue(schedule, latest);
        if (reconciled !== latest) {
          window.localStorage.setItem(PUBLICATION_STORAGE_KEY, JSON.stringify(reconciled));
        }
        return reconciled;
      }).then((reconciled) => {
        if (cancelled || !reconciled) return;
        setQueue(reconciled);
        reconciledScheduleRevisionRef.current = scheduleRevision;
      }).catch(() => {
        if (cancelled) return;
        reconciledScheduleRevisionRef.current = "";
        setStorageAvailable(false);
        setNotice("Stockage local indisponible : la file passe en lecture seule.");
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    mutationLockAvailable,
    schedule,
    scheduleRevision,
    storageAvailable,
    storageReady,
    syncing,
    workflowAvailable,
    workflowReady,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const plans = useMemo(
    () => workflowReady && storageReady
      ? sortedPublicationPlans(workflowAvailable ? mergedQueue : queue)
      : [],
    [mergedQueue, queue, storageReady, workflowAvailable, workflowReady],
  );
  const scheduledPlans = useMemo<LocalPublicationScheduleEntry[]>(
    () => plans
      .filter((plan) => plan.status === "scheduled")
      .map((plan) => ({
        ideaId: plan.ideaId,
        publishAtLocal: plan.publishAtLocal,
        platforms: plan.platforms,
        caption: plan.caption,
      })),
    [plans],
  );

  useEffect(() => {
    onScheduledPlansChange(
      workflowReady && workflowAvailable && storageReady && storageAvailable && mutationLockAvailable
        ? scheduledPlans
        : [],
    );
  }, [
    mutationLockAvailable,
    onScheduledPlansChange,
    scheduledPlans,
    storageAvailable,
    storageReady,
    workflowAvailable,
    workflowReady,
  ]);

  useEffect(() => {
    onStorageAvailabilityChange(storageReady && storageAvailable && mutationLockAvailable);
  }, [mutationLockAvailable, onStorageAvailabilityChange, storageAvailable, storageReady]);

  const counts = useMemo(() => ({
    draft: plans.filter((plan) => plan.status === "draft").length,
    approved: plans.filter((plan) => plan.status === "approved").length,
    scheduled: plans.filter((plan) => plan.status === "scheduled").length,
  }), [plans]);
  const filteredPlans = plans.filter((plan) => plan.status === filter);
  const interactionsLocked = syncing ||
    !workflowReady ||
    !workflowAvailable ||
    !storageReady ||
    !storageAvailable ||
    !mutationLockAvailable;

  const replacePlan = useCallback((plan: PublicationPlan, expectedPlan: PublicationPlan): boolean => {
    if (!workflowAvailable || !storageAvailable || !storageReady) return false;
    try {
      const baseQueue = mergeScheduledIdeasIntoPublicationQueue(
        schedule,
        readPublicationStorage().queue,
      );
      const freshPlan = baseQueue.plans[plan.ideaId];
      if (!freshPlan || !samePublicationSnapshot(freshPlan, expectedPlan)) {
        setQueue(baseQueue);
        if (freshPlan) setFilter(freshPlan.status);
        setNotice("Cette fiche a changé dans un autre onglet. La version récente a été rechargée.");
        return false;
      }
      const nextQueue: PublicationQueueState = {
        version: 1,
        plans: { ...baseQueue.plans, [plan.ideaId]: plan },
        tombstones: baseQueue.tombstones,
      };
      if (plan.status === "scheduled") {
        const collision = findPublicationScheduleCollision(plan, baseQueue);
        if (collision) {
          setNotice(`Créneau déjà occupé par « ${collision.title} ». Choisis une autre heure.`);
          return false;
        }
      }
      window.localStorage.setItem(PUBLICATION_STORAGE_KEY, JSON.stringify(nextQueue));
      setQueue(nextQueue);
    } catch {
      setStorageAvailable(false);
      setNotice("Stockage local indisponible : aucune modification n’a été enregistrée.");
      return false;
    }
    return true;
  }, [schedule, storageAvailable, storageReady, workflowAvailable]);

  const editPlan = useCallback((plan: PublicationPlan, patch: PublicationPlanPatch) => {
    void withPublicationMutationLock(() => {
      if (!workflowAvailable || !storageAvailable || !storageReady) {
        return { saved: false, queue: null, invalidated: false, conflict: false };
      }
      const baseQueue = mergeScheduledIdeasIntoPublicationQueue(
        schedule,
        readPublicationStorage().queue,
      );
      const freshPlan = baseQueue.plans[plan.ideaId];
      if (!freshPlan || freshPlan.sourceScheduleFingerprint !== plan.sourceScheduleFingerprint) {
        return { saved: false, queue: baseQueue, invalidated: false, conflict: true };
      }
      const nextPlan = updatePublicationPlan(freshPlan, patch);
      if (nextPlan === freshPlan) {
        return { saved: true, queue: baseQueue, invalidated: false, conflict: false };
      }
      const nextQueue: PublicationQueueState = {
        version: 1,
        plans: { ...baseQueue.plans, [nextPlan.ideaId]: nextPlan },
        tombstones: baseQueue.tombstones,
      };
      window.localStorage.setItem(PUBLICATION_STORAGE_KEY, JSON.stringify(nextQueue));
      return {
        saved: true,
        queue: nextQueue,
        invalidated: freshPlan.status !== "draft",
        conflict: false,
      };
    }).then((result) => {
      if (result.queue) setQueue(result.queue);
      if (result.conflict) {
        setNotice("Cette fiche a changé dans un autre onglet. La version récente a été rechargée.");
        return;
      }
      if (result.invalidated) {
        setFilter("draft");
        setNotice("Modification enregistrée : la validation et le planning précédents ont été annulés.");
      }
    }).catch((error) => {
      setStorageAvailable(false);
      setNotice(
        error instanceof Error
          ? error.message
          : "Stockage local indisponible : aucune modification n’a été enregistrée.",
      );
    });
  }, [schedule, storageAvailable, storageReady, workflowAvailable]);

  const runCriticalTransition = useCallback(async (
    nextPlan: PublicationPlan,
    expectedPlan: PublicationPlan,
  ): Promise<boolean> => {
    if (transitionPendingRef.current) {
      setNotice("Une modification sécurisée est déjà en cours.");
      return false;
    }
    transitionPendingRef.current = true;
    setPendingIdeaId(expectedPlan.ideaId);
    try {
      return await withPublicationMutationLock(() => replacePlan(nextPlan, expectedPlan));
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "La modification sécurisée n’a pas pu être enregistrée.",
      );
      return false;
    } finally {
      transitionPendingRef.current = false;
      setPendingIdeaId(null);
    }
  }, [replacePlan]);

  const approvePlan = useCallback((plan: PublicationPlan) => {
    try {
      const approved = approvePublicationPlan(plan);
      void runCriticalTransition(approved, plan).then((saved) => {
        if (!saved) return;
        setFilter("approved");
        setNotice("✓ Version finale validée. Toute modification annulera cette validation.");
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Le contenu est incomplet.");
    }
  }, [runCriticalTransition]);

  const addToLocalPlanning = useCallback((plan: PublicationPlan) => {
    try {
      const scheduledPlan = markPublicationPlanScheduled(plan);
      void runCriticalTransition(scheduledPlan, plan).then((saved) => {
        if (!saved) return;
        setFilter("scheduled");
        setNotice("🗓️ Ajouté au planning local. Aucun envoi automatique n’a été déclenché.");
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Planification impossible.");
    }
  }, [runCriticalTransition]);

  const retryStorage = useCallback(() => {
    if (syncing) {
      setNotice("Attends la fin de la décision éditoriale avant de réessayer.");
      return;
    }
    void withPublicationMutationLock(() => {
      const latest = readPublicationStorage().queue;
      const reconciled = mergeScheduledIdeasIntoPublicationQueue(schedule, latest);
      window.localStorage.setItem(PUBLICATION_STORAGE_KEY, JSON.stringify(reconciled));
      return reconciled;
    }).then((reconciled) => {
      setQueue(reconciled);
      reconciledScheduleRevisionRef.current = scheduleRevision;
      setStorageAvailable(true);
      setNotice("Stockage local rétabli.");
    }).catch(() => {
      setStorageAvailable(false);
      setNotice("Le stockage local reste indisponible.");
    });
  }, [schedule, scheduleRevision, syncing]);

  const revokePlan = useCallback((plan: PublicationPlan) => {
    void runCriticalTransition(revokePublicationPlan(plan), plan).then((saved) => {
      if (!saved) return;
      setFilter("draft");
      setNotice(
        plan.status === "scheduled"
          ? "Retiré du planning local. Le contenu repasse à préparer."
          : "Validation annulée. Le contenu repasse à préparer.",
      );
    });
  }, [runCriticalTransition]);

  const copyCaption = useCallback(async (plan: PublicationPlan) => {
    try {
      if (!navigator.clipboard) throw new Error("Copie indisponible dans ce navigateur.");
      await navigator.clipboard.writeText(plan.caption);
      setNotice("Texte copié.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Copie impossible.");
    }
  }, []);

  return (
    <section className="publication-cockpit" aria-label="Préparation et programmation des contenus">
      <div className="publication-security-note" role="note">
        <span aria-hidden="true">🔒</span>
        <div>
          <b>Planning local · aucune publication automatique</b>
          <p>Les contenus peuvent être préparés, validés et datés ici. L’envoi direct restera verrouillé jusqu’à la connexion sécurisée des comptes officiels côté serveur.</p>
        </div>
      </div>

      <div className="publication-connectors" aria-label="Connexions de publication">
        {PLATFORM_ORDER.map((platform) => (
          <article className="publication-connector" key={platform}>
            <img src={`platforms/${platform}.svg`} width="26" height="26" alt="" />
            <div>
              <b>{PLATFORM_META[platform].label}</b>
              <span>Non connecté · connecteur serveur requis</span>
            </div>
            <button type="button" disabled title="Connexion sécurisée côté serveur requise">
              Connecteur requis
            </button>
          </article>
        ))}
      </div>

      {!workflowAvailable && workflowReady ? (
        <p className="publication-warning" role="alert">
          <span>Workflow indisponible : la file locale est préservée en lecture seule.</span>
          <button type="button" onClick={onRetryWorkflow}>Réessayer</button>
        </p>
      ) : null}
      {!storageAvailable && storageReady ? (
        <p className="publication-warning" role="alert">
          <span>Stockage local indisponible : validation et planning désactivés pour éviter tout faux succès.</span>
          <button type="button" disabled={syncing} onClick={retryStorage}>Réessayer</button>
        </p>
      ) : null}
      {!mutationLockAvailable && storageReady ? (
        <p className="publication-warning" role="alert">
          <span>Verrou multi-onglets indisponible : validation et planning restent en lecture seule.</span>
        </p>
      ) : null}

      <div className="publication-statusbar">
        <div className="publication-status-tabs" role="group" aria-label="État des contenus à publier">
          <PublicationStatusButton current={filter} value="draft" count={counts.draft} onChange={setFilter}>À préparer</PublicationStatusButton>
          <PublicationStatusButton current={filter} value="approved" count={counts.approved} onChange={setFilter}>Validés</PublicationStatusButton>
          <PublicationStatusButton current={filter} value="scheduled" count={counts.scheduled} onChange={setFilter}>Planifiés</PublicationStatusButton>
        </div>
        <span className="publication-timezone">Europe/Paris</span>
      </div>

      {notice ? <p className="publication-notice" role="status">{notice}</p> : null}

      {!workflowReady || !storageReady ? (
        <div className="publication-loading">Préparation de la file…</div>
      ) : !plans.length ? (
        <div className="empty-state publication-empty">
          <span>🚀</span>
          <h3>Aucun contenu validé à préparer</h3>
          <p>Valide d’abord un post dans Extraction. Il apparaîtra ici comme brouillon, jamais comme autorisation de publier.</p>
          <button className="button primary" type="button" onClick={onOpenRecommendations}>Voir l’extraction</button>
        </div>
      ) : !filteredPlans.length ? (
        <div className="empty-state publication-empty compact">
          <span>✓</span>
          <h3>Aucun contenu dans cet état</h3>
          <p>Change de filtre pour retrouver le reste de la file.</p>
        </div>
      ) : (
        <div className="publication-plan-grid">
          {filteredPlans.map((plan) => (
            <PublicationPlanCard
              plan={plan}
              locked={interactionsLocked || pendingIdeaId !== null}
              onEdit={editPlan}
              onApprove={approvePlan}
              onSchedule={addToLocalPlanning}
              onRevoke={revokePlan}
              onCopy={copyCaption}
              key={plan.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PublicationStatusButton({
  current,
  value,
  count,
  onChange,
  children,
}: {
  current: PublicationFilter;
  value: PublicationFilter;
  count: number;
  onChange: (value: PublicationFilter) => void;
  children: ReactNode;
}) {
  return (
    <button
      className={current === value ? "active" : ""}
      type="button"
      aria-pressed={current === value}
      onClick={() => onChange(value)}
    >
      <span>{children}</span><b>{count}</b>
    </button>
  );
}

function PublicationPlanCard({
  plan,
  locked,
  onEdit,
  onApprove,
  onSchedule,
  onRevoke,
  onCopy,
}: {
  plan: PublicationPlan;
  locked: boolean;
  onEdit: (plan: PublicationPlan, patch: PublicationPlanPatch) => void;
  onApprove: (plan: PublicationPlan) => void;
  onSchedule: (plan: PublicationPlan) => void;
  onRevoke: (plan: PublicationPlan) => void;
  onCopy: (plan: PublicationPlan) => void;
}) {
  const issues = publicationReadinessIssues(plan);
  const statusLabel = plan.status === "draft"
    ? "À préparer"
    : plan.status === "approved"
      ? "Version validée"
      : "Planning local";

  const togglePlatform = (platform: SocialPlatform) => {
    const selected = plan.platforms.includes(platform)
      ? plan.platforms.filter((item) => item !== platform)
      : [...plan.platforms, platform];
    onEdit(plan, { platforms: selected });
  };

  return (
    <article className={`publication-plan-card status-${plan.status}`}>
      <header>
        <div>
          <span className="publication-plan-format">{plan.format}</span>
          <h3>{plan.title}</h3>
        </div>
        <span className="publication-plan-status">{statusLabel}</span>
      </header>

      <fieldset className="publication-platform-picker" disabled={locked}>
        <legend>Réseaux associés</legend>
        <div>
          {PLATFORM_ORDER.map((platform) => {
            const selected = plan.platforms.includes(platform);
            return (
              <button
                className={selected ? "selected" : ""}
                type="button"
                aria-pressed={selected}
                onClick={() => togglePlatform(platform)}
                key={platform}
              >
                <img src={`platforms/${platform}.svg`} width="20" height="20" alt="" />
                <span>{PLATFORM_META[platform].label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="publication-field publication-caption-field">
        <span>Texte final</span>
        <textarea
          rows={4}
          value={plan.caption}
          disabled={locked}
          onChange={(event) => onEdit(plan, { caption: event.target.value })}
        />
      </label>

      <div className="publication-plan-fields">
        <label className="publication-field publication-media-field">
          <span>Lien média · URL HTTPS sans identifiants ni paramètres</span>
          <input
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={plan.mediaUrl}
            disabled={locked}
            onChange={(event) => onEdit(plan, { mediaUrl: event.target.value })}
          />
        </label>
        <label className="publication-field publication-date-field">
          <span>Date et heure</span>
          <input
            type="datetime-local"
            value={plan.publishAtLocal}
            disabled={locked}
            onChange={(event) => onEdit(plan, { publishAtLocal: event.target.value })}
          />
        </label>
      </div>

      {issues.length ? (
        <ul className="publication-readiness" aria-label="Éléments à compléter">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : (
        <p className="publication-ready">✓ Prêt pour une validation éditoriale locale</p>
      )}

      <footer>
        <button className="button secondary" type="button" onClick={() => void onCopy(plan)}>Copier le texte</button>
        {plan.status === "draft" ? (
          <button className="button primary" type="button" disabled={locked || Boolean(issues.length)} onClick={() => onApprove(plan)}>
            Valider le contenu
          </button>
        ) : null}
        {plan.status === "approved" ? (
          <button className="button primary" type="button" disabled={locked} onClick={() => onSchedule(plan)}>
            Ajouter au planning local
          </button>
        ) : null}
        {plan.status === "scheduled" ? (
          <span className="publication-planned-label">🗓️ {plan.publishAtLocal.replace("T", " · ")}</span>
        ) : null}
        {plan.status === "approved" || plan.status === "scheduled" ? (
          <button className="button secondary" type="button" disabled={locked} onClick={() => onRevoke(plan)}>
            {plan.status === "scheduled" ? "Retirer du planning" : "Annuler la validation"}
          </button>
        ) : null}
        <button
          className="button publication-disabled-action"
          type="button"
          disabled
          title="Publication directe indisponible sur la version publique"
        >
          Publier maintenant
        </button>
        <button
          className="button publication-disabled-action"
          type="button"
          disabled
          title="Ordonnanceur serveur requis"
        >
          Programmer automatiquement
        </button>
      </footer>

      <div className="publication-manual-links" aria-label="Ouvrir les plateformes sélectionnées">
        {plan.platforms.map((platform) => (
          <a href={PLATFORM_META[platform].openUrl} target="_blank" rel="noreferrer" key={platform}>
            Ouvrir {PLATFORM_META[platform].label}
          </a>
        ))}
      </div>
    </article>
  );
}

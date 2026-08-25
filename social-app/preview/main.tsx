import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SocialOS, type WorkspacePayload } from "../app/SocialOS";
import "../app/globals.css";
import audienceHistoryJson from "../data/audience-history.json";
import audioTrendFeedJson from "../data/audio-trends/feed.json";
import audioTrendScanStatusJson from "../data/audio-trends/refresh-status.json";
import commentOpportunityFeedJson from "../data/comment-opportunities/feed.json";
import publicHistorySummaryJson from "../data/public-history-summary.json";
import trendFeedJson from "../data/trends/feed.json";
import videoTrendScanStatusJson from "../data/trends/refresh-status.json";
import {
  assertAudienceHistory,
  type AudienceHistory,
} from "../lib/audience-metrics";
import {
  assertAudioTrendFeed,
  type AudioTrendFeed,
} from "../lib/audio-trends";
import {
  assertCommentOpportunityFeed,
  type CommentOpportunityFeed,
} from "../lib/comment-opportunities";
import {
  mergeWorkspaceWithPublicHistory,
  type PublicHistorySnapshot,
  type PublicHistorySummary,
} from "../lib/public-history";
import type { SocialPlatform } from "../lib/social-scanner";
import {
  assertSocialTrendFeed,
  type SocialTrendFeed,
} from "../lib/social-trends";
import {
  assertAudioTrendScanStatus,
  assertVideoTrendScanStatus,
  type AudioTrendScanStatus,
  type VideoTrendScanStatus,
} from "../lib/trend-scan-status";

const PLATFORM_ORDER: SocialPlatform[] = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
];
const publicHistorySummary = publicHistorySummaryJson as PublicHistorySummary;
const fallbackTrendFeed = assertSocialTrendFeed(
  trendFeedJson as SocialTrendFeed,
);
const fallbackAudienceHistory = assertAudienceHistory(
  audienceHistoryJson as AudienceHistory,
);
const fallbackAudioTrendFeed = assertAudioTrendFeed(
  audioTrendFeedJson as AudioTrendFeed,
);
const fallbackVideoTrendScanStatus = assertVideoTrendScanStatus(
  videoTrendScanStatusJson as VideoTrendScanStatus,
);
const fallbackAudioTrendScanStatus = assertAudioTrendScanStatus(
  audioTrendScanStatusJson as AudioTrendScanStatus,
);
const fallbackCommentOpportunityFeed = assertCommentOpportunityFeed(
  commentOpportunityFeedJson as CommentOpportunityFeed,
);
const dataBaseUrl = `${import.meta.env.BASE_URL}data`;
const liveDataBaseUrl = "https://raw.githubusercontent.com/dim75017/youtube-radar-kx9v2m/main/social-app/data";
const RAW_TREND_FEED_URL = `${liveDataBaseUrl}/trends/feed.json`;
const RAW_AUDIO_TREND_FEED_URL = `${liveDataBaseUrl}/audio-trends/feed.json`;
const RAW_VIDEO_TREND_STATUS_URL = `${liveDataBaseUrl}/trends/refresh-status.json`;
const RAW_AUDIO_TREND_STATUS_URL = `${liveDataBaseUrl}/audio-trends/refresh-status.json`;
const RAW_AUDIENCE_HISTORY_URL = `${liveDataBaseUrl}/audience-history.json`;
const RAW_COMMENT_OPPORTUNITIES_URL = `${liveDataBaseUrl}/comment-opportunities/feed.json`;
const emptySnapshot: PublicHistorySnapshot = {
  generatedAt: publicHistorySummary.generatedAt,
  coverage: publicHistorySummary.coverage,
  posts: [],
};
const initialWorkspace = mergeWorkspaceWithPublicHistory(
  null,
  emptySnapshot,
  "public-snapshot",
  {
    editorialAnalysis: "none",
    accountCounts: publicHistorySummary.platformCounts,
  },
);
const snapshotVersion = encodeURIComponent(
  `${publicHistorySummary.generatedAt}:${publicHistorySummary.totalPostCount}:${JSON.stringify(publicHistorySummary.formatCounts)}`,
);

function PublicPreview() {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [trendFeed, setTrendFeed] = useState(fallbackTrendFeed);
  const [audioTrendFeed, setAudioTrendFeed] = useState(fallbackAudioTrendFeed);
  const [videoTrendScanStatus, setVideoTrendScanStatus] = useState(fallbackVideoTrendScanStatus);
  const [audioTrendScanStatus, setAudioTrendScanStatus] = useState(fallbackAudioTrendScanStatus);
  const [audienceHistory, setAudienceHistory] = useState(fallbackAudienceHistory);
  const [commentOpportunityFeed, setCommentOpportunityFeed] = useState(fallbackCommentOpportunityFeed);
  const [pendingPlatforms, setPendingPlatforms] = useState<SocialPlatform[]>([
    ...PLATFORM_ORDER,
  ]);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refreshTrendFeed = () => {
      void fetch(`${RAW_TREND_FEED_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Actualisation Trends impossible (${response.status}).`);
          }
          return assertSocialTrendFeed(
            (await response.json()) as SocialTrendFeed,
          );
        })
        .then((snapshot) => {
          if (!active) return;
          const incomingAt = Date.parse(snapshot.capturedAt);
          if (!Number.isFinite(incomingAt)) return;
          setTrendFeed((current) => {
            const currentAt = Date.parse(current.capturedAt);
            return !Number.isFinite(currentAt) || incomingAt >= currentAt
              ? snapshot
              : current;
          });
        })
        .catch(() => {
          // Le snapshot embarqué reste disponible hors ligne ou si GitHub est indisponible.
        });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshTrendFeed();
    };

    refreshTrendFeed();
    const hourlyRefresh = window.setInterval(refreshTrendFeed, 60 * 60 * 1_000);
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      active = false;
      window.clearInterval(hourlyRefresh);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refreshTrendScanStatuses = () => {
      const version = Date.now();
      void Promise.allSettled([
        fetch(`${RAW_VIDEO_TREND_STATUS_URL}?v=${version}`, {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Statut vidéo indisponible (${response.status}).`);
          return assertVideoTrendScanStatus(await response.json());
        }),
        fetch(`${RAW_AUDIO_TREND_STATUS_URL}?v=${version}`, {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Statut audio indisponible (${response.status}).`);
          return assertAudioTrendScanStatus(await response.json());
        }),
      ]).then(([videoResult, audioResult]) => {
        if (!active) return;
        if (videoResult.status === "fulfilled") {
          setVideoTrendScanStatus((current) =>
            Date.parse(videoResult.value.lastAttemptAt) >= Date.parse(current.lastAttemptAt)
              ? videoResult.value
              : current,
          );
        }
        if (audioResult.status === "fulfilled") {
          setAudioTrendScanStatus((current) =>
            Date.parse(audioResult.value.attemptedAt) >= Date.parse(current.attemptedAt)
              ? audioResult.value
              : current,
          );
        }
      });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshTrendScanStatuses();
    };

    refreshTrendScanStatuses();
    const hourlyRefresh = window.setInterval(refreshTrendScanStatuses, 60 * 60 * 1_000);
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      active = false;
      window.clearInterval(hourlyRefresh);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refreshAudioTrendFeed = () => {
      void fetch(`${RAW_AUDIO_TREND_FEED_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Actualisation Trends audio impossible (${response.status}).`);
          }
          return assertAudioTrendFeed((await response.json()) as AudioTrendFeed);
        })
        .then((snapshot) => {
          if (!active) return;
          const incomingAt = Date.parse(snapshot.capturedAt);
          if (!Number.isFinite(incomingAt)) return;
          setAudioTrendFeed((current) => (
            incomingAt >= Date.parse(current.capturedAt) ? snapshot : current
          ));
        })
        .catch(() => {
          // Le snapshot embarqué reste disponible si le relevé quotidien est indisponible.
        });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshAudioTrendFeed();
    };

    refreshAudioTrendFeed();
    const hourlyRefresh = window.setInterval(refreshAudioTrendFeed, 60 * 60 * 1_000);
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      active = false;
      window.clearInterval(hourlyRefresh);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refreshAudienceHistory = () => {
      void fetch(`${RAW_AUDIENCE_HISTORY_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Actualisation audience impossible (${response.status}).`);
          }
          return assertAudienceHistory(
            (await response.json()) as AudienceHistory,
          );
        })
        .then((snapshot) => {
          if (!active) return;
          const incomingAt = Date.parse(snapshot.generatedAt);
          if (!Number.isFinite(incomingAt)) return;
          setAudienceHistory((current) =>
            incomingAt >= Date.parse(current.generatedAt) ? snapshot : current,
          );
        })
        .catch(() => {
          // Le dernier relevé embarqué reste visible si GitHub est indisponible.
        });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshAudienceHistory();
    };

    refreshAudienceHistory();
    const hourlyRefresh = window.setInterval(
      refreshAudienceHistory,
      60 * 60 * 1_000,
    );
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      active = false;
      window.clearInterval(hourlyRefresh);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refreshCommentOpportunities = () => {
      void fetch(`${RAW_COMMENT_OPPORTUNITIES_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Actualisation Commentaires impossible (${response.status}).`);
          }
          return assertCommentOpportunityFeed(
            (await response.json()) as CommentOpportunityFeed,
          );
        })
        .then((snapshot) => {
          if (!active) return;
          const incomingAt = Date.parse(snapshot.capturedAt);
          if (!Number.isFinite(incomingAt)) return;
          setCommentOpportunityFeed((current) => {
            const currentAt = Date.parse(current.capturedAt);
            return !Number.isFinite(currentAt) || incomingAt >= currentAt
              ? snapshot
              : current;
          });
        })
        .catch(() => {
          // Le dernier snapshot vérifié reste visible hors ligne.
        });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshCommentOpportunities();
    };

    refreshCommentOpportunities();
    const hourlyRefresh = window.setInterval(refreshCommentOpportunities, 60 * 60 * 1_000);
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      active = false;
      window.clearInterval(hourlyRefresh);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const snapshots = new Map<SocialPlatform, PublicHistorySnapshot>();

    const publishLoadedSnapshots = () => {
      if (!active) return;
      const snapshot: PublicHistorySnapshot = {
        generatedAt: publicHistorySummary.generatedAt,
        coverage: publicHistorySummary.coverage,
        posts: PLATFORM_ORDER.flatMap(
          (platform) => snapshots.get(platform)?.posts ?? [],
        ),
      };
      setWorkspace(
        mergeWorkspaceWithPublicHistory(null, snapshot, "public-snapshot", {
          editorialAnalysis: "leaders",
          accountCounts: publicHistorySummary.platformCounts,
        }),
      );
    };

    const loadPlatform = async (platform: SocialPlatform) => {
      const snapshot = await fetchSnapshot(
        `public-history-${platform}.json`,
        controller.signal,
      );
      if (snapshot.generatedAt !== publicHistorySummary.generatedAt) {
        throw new Error(`Version ${platform} incohérente.`);
      }
      snapshots.set(platform, snapshot);
      publishLoadedSnapshots();
      if (active) {
        setPendingPlatforms((current) =>
          current.filter((candidate) => candidate !== platform),
        );
      }
    };

    void Promise.allSettled(PLATFORM_ORDER.map(loadPlatform)).then(
      async (results) => {
        if (!active || results.every((result) => result.status === "fulfilled")) {
          return;
        }
        try {
          const snapshot = await fetchSnapshot(
            "public-history.json",
            controller.signal,
          );
          if (!active) return;
          setWorkspace(
            mergeWorkspaceWithPublicHistory(null, snapshot, "public-snapshot", {
              editorialAnalysis: "leaders",
              accountCounts: publicHistorySummary.platformCounts,
            }),
          );
          setPendingPlatforms([]);
        } catch {
          if (!active || controller.signal.aborted) return;
          setPendingPlatforms([]);
          setHistoryError(
            "Les compteurs sont à jour, mais les fiches détaillées n’ont pas pu être chargées.",
          );
        }
      },
    );

    void fetchLiveSnapshot("public-history.json", controller.signal)
      .then((snapshot) => {
        if (!active) return;
        setWorkspace(
          mergeWorkspaceWithPublicHistory(null, snapshot, "public-snapshot", {
            editorialAnalysis: "leaders",
            accountCounts: publicHistorySummary.platformCounts,
          }),
        );
        setPendingPlatforms([]);
        setHistoryError("");
      })
      .catch(() => undefined);

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return (
    <SocialOS
      initialWorkspace={workspace as WorkspacePayload}
      initialTrendFeed={trendFeed}
      initialAudioTrendFeed={audioTrendFeed}
      initialVideoTrendScanStatus={videoTrendScanStatus}
      initialAudioTrendScanStatus={audioTrendScanStatus}
      initialCommentOpportunityFeed={commentOpportunityFeed}
      initialAudienceHistory={audienceHistory}
      previewMode
      publicCounts={publicHistorySummary.platformCounts}
      publicFormatCounts={publicHistorySummary.formatCounts}
      pendingPlatforms={pendingPlatforms}
      historyError={historyError}
    />
  );
}

async function fetchSnapshot(
  filename: string,
  signal: AbortSignal,
): Promise<PublicHistorySnapshot> {
  const response = await fetch(
    `${dataBaseUrl}/${filename}?v=${snapshotVersion}`,
    { cache: "force-cache", signal },
  );
  if (!response.ok) throw new Error(`Chargement impossible (${response.status}).`);
  return (await response.json()) as PublicHistorySnapshot;
}

async function fetchLiveSnapshot(
  filename: string,
  signal: AbortSignal,
): Promise<PublicHistorySnapshot> {
  const response = await fetch(
    `${liveDataBaseUrl}/${filename}?v=${Date.now()}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error(`Actualisation impossible (${response.status}).`);
  return (await response.json()) as PublicHistorySnapshot;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PublicPreview />
  </StrictMode>,
);

import type { Metadata } from "next";
import audienceHistoryJson from "../data/audience-history.json";
import audioTrendScanStatusJson from "../data/audio-trends/refresh-status.json";
import commentOpportunityFeedJson from "../data/comment-opportunities/feed.json";
import playlistPromoFeedJson from "../data/playlist-promos/feed.json";
import scrollingFeedJson from "../data/scrolling/feed.json";
import videoTrendScanStatusJson from "../data/trends/refresh-status.json";
import {
  assertAudienceHistory,
  type AudienceHistory,
} from "../lib/audience-metrics";
import {
  assertCommentOpportunityFeed,
  type CommentOpportunityFeed,
} from "../lib/comment-opportunities";
import {
  assertPlaylistPromoFeed,
  type PlaylistPromoFeed,
} from "../lib/playlist-promos";
import {
  assertScrollingFeed,
  type ScrollingFeed,
} from "../lib/scrolling";
import {
  assertAudioTrendScanStatus,
  assertVideoTrendScanStatus,
  type AudioTrendScanStatus,
  type VideoTrendScanStatus,
} from "../lib/trend-scan-status";
import { SocialOS } from "./SocialOS";

export const metadata: Metadata = {
  title: { absolute: "Lofi Radar · Social" },
  description:
    "Social & Community Intelligence OS · de la tendance détectée à la décision éditoriale.",
};

export default function Home() {
  return (
    <SocialOS
      initialScrollingFeed={assertScrollingFeed(
        scrollingFeedJson as ScrollingFeed,
      )}
      initialPlaylistPromoFeed={assertPlaylistPromoFeed(
        playlistPromoFeedJson as PlaylistPromoFeed,
      )}
      initialCommentOpportunityFeed={assertCommentOpportunityFeed(
        commentOpportunityFeedJson as CommentOpportunityFeed,
      )}
      initialAudienceHistory={assertAudienceHistory(
        audienceHistoryJson as AudienceHistory,
      )}
      initialVideoTrendScanStatus={assertVideoTrendScanStatus(
        videoTrendScanStatusJson as VideoTrendScanStatus,
      )}
      initialAudioTrendScanStatus={assertAudioTrendScanStatus(
        audioTrendScanStatusJson as AudioTrendScanStatus,
      )}
    />
  );
}

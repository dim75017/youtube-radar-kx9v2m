import type { Metadata } from "next";
import audienceHistoryJson from "../data/audience-history.json";
import audioTrendScanStatusJson from "../data/audio-trends/refresh-status.json";
import commentOpportunityFeedJson from "../data/comment-opportunities/feed.json";
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

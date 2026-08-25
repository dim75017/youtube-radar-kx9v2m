import audioTrendFeedJson from "../../../data/audio-trends/feed.json";

import {
  assertAudioTrendFeed,
  type AudioTrendFeed,
} from "../../../lib/audio-trends";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(
      assertAudioTrendFeed(audioTrendFeedJson as AudioTrendFeed),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Le snapshot Trends audio est invalide.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

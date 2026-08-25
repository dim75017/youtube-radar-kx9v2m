import trendFeedJson from "../../../data/trends/feed.json";
import { routeError } from "../../../db/runtime";
import {
  assertSocialTrendFeed,
  type SocialTrendFeed,
} from "../../../lib/social-trends";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = assertSocialTrendFeed(
      trendFeedJson as SocialTrendFeed,
    );
    return Response.json(snapshot, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST() {
  return Response.json(
    {
      error:
        "Le feed Trends est publié comme un snapshot vérifié. Les ajouts manuels non sourcés sont refusés.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

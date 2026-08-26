import scrollingFeedJson from "../../../data/scrolling/feed.json";
import scrollingThemesJson from "../../../data/scrolling/themes.json";

import {
  assertScrollingFeed,
  type ScrollingFeed,
  type ScrollingThemeCatalog,
} from "../../../lib/scrolling";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(
      assertScrollingFeed(
        scrollingFeedJson as ScrollingFeed,
        scrollingThemesJson as ScrollingThemeCatalog,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Le snapshot Scrolling est invalide.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST() {
  return Response.json(
    {
      error: "Le scroll connecté exige une navigation privée explicitement confiée et une revue éditoriale. Les ajouts non attestés sont refusés.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

import playlistPromoFeedJson from "../../../data/playlist-promos/feed.json";

import {
  assertPlaylistPromoFeed,
  type PlaylistPromoFeed,
} from "../../../lib/playlist-promos";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(
      assertPlaylistPromoFeed(playlistPromoFeedJson as PlaylistPromoFeed),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Le snapshot Pubs playlists est invalide.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST() {
  return Response.json(
    {
      error: "Le benchmark est publié comme un snapshot vérifié. Les ajouts manuels non sourcés sont refusés.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

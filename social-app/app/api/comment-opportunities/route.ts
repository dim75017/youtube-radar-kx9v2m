import commentOpportunityFeedJson from "../../../data/comment-opportunities/feed.json";
import { routeError } from "../../../db/runtime";
import {
  assertCommentOpportunityFeed,
  type CommentOpportunityFeed,
} from "../../../lib/comment-opportunities";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = assertCommentOpportunityFeed(
      commentOpportunityFeedJson as CommentOpportunityFeed,
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
        "Le feed Commentaires est un snapshot vérifié. Aucun commentaire n’est publié automatiquement.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

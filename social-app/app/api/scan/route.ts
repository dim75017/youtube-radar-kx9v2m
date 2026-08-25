import {
  SOCIAL_PLATFORMS,
  actorFromRequest,
  routeError,
  runSocialScan,
  type SupportedSocialPlatform,
} from "../../../db/runtime";

export const dynamic = "force-dynamic";

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function isAuthenticatedSitesRequest(request: Request) {
  return Boolean(request.headers.get("oai-authenticated-user-id")?.trim());
}

function isSupportedPlatform(
  value: unknown,
): value is SupportedSocialPlatform {
  return (
    typeof value === "string" &&
    SOCIAL_PLATFORMS.includes(value as SupportedSocialPlatform)
  );
}

export async function POST(request: Request) {
  if (!isLocalRequest(request) && !isAuthenticatedSitesRequest(request)) {
    return Response.json(
      { error: "Authentification requise pour lancer un scan." },
      { status: 401 },
    );
  }

  try {
    const bodyText = await request.text();
    let requestedPlatform: unknown;
    if (bodyText.trim()) {
      try {
        requestedPlatform = (JSON.parse(bodyText) as { platform?: unknown })
          .platform;
      } catch {
        return Response.json(
          { error: "Le corps de la requête doit être un JSON valide." },
          { status: 400 },
        );
      }
    }

    if (
      requestedPlatform != null &&
      requestedPlatform !== "all" &&
      !isSupportedPlatform(requestedPlatform)
    ) {
      return Response.json(
        {
          error:
            "Plateforme invalide. Utilise youtube, instagram, tiktok, x ou all.",
        },
        { status: 400 },
      );
    }

    const results = await runSocialScan({
      platform:
        requestedPlatform === "all" || requestedPlatform == null
          ? undefined
          : requestedPlatform,
      trigger: "manual",
      actorLabel: actorFromRequest(request),
    });

    return Response.json({
      generatedAt: new Date().toISOString(),
      results,
    });
  } catch (error) {
    return routeError(error);
  }
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

const cloudflareStub = "data:text/javascript,export const env = {};";
const loaderSource = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: ${JSON.stringify(cloudflareStub)} };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the live Social Radar shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Lofi Radar · Social<\/title>/i);
  assert.match(html, /Tableau de bord/);
  assert.match(html, /Tous les posts/);
  assert.match(html, /Commentaires/);
  assert.match(html, /Posts recommandés/);
  assert.match(html, /Trends vid.os/);
  assert.match(html, /Trends audio/);
  assert.match(html, /Recommandations/);
  assert.match(html, /Roadmap/);
  assert.match(html, /id="posts-platform-subnav"/);
  assert.match(html, /id="recommendations-subnav"/);
  assert.doesNotMatch(html, /<div[^>]*id="posts-platform-subnav"[^>]*\shidden\b/);
  assert.doesNotMatch(html, /<div[^>]*id="recommendations-subnav"[^>]*\shidden\b/);
  assert.doesNotMatch(html, /Données publiques réelles|Snapshot public interactif|Générer les idées/);
  assert.match(html, /Instagram, X, TikTok et YouTube/);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.doesNotMatch(html, /🧪 Démo|Données de démonstration|codex-preview|react-loading-skeleton/i);
});

test("keeps real social collection, post formats and persistence explicit", async () => {
  const [
    viteConfig,
    schema,
    component,
    formats,
    durations,
    scanner,
    publicHistory,
    packageJson,
    styles,
    socialMedia,
    socialRanking,
    previewEntry,
    audienceMetrics,
    audienceHistory,
    audienceAnalyticsModel,
    audienceAnalyticsSnapshot,
    publicPreviewBuilder,
    youtubeLogo,
    instagramLogo,
    tiktokLogo,
    xLogo,
    commentOpportunities,
    commentOpportunityModel,
    commentOpportunityFeed,
    audioTrendView,
    audioTrendModel,
    audioTrendFeed,
    socialInlinePlayer,
    socialInlinePlayerModel,
  ] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-formats.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-duration.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-scanner.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/public-history.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-media.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-ranking.ts", import.meta.url), "utf8"),
    readFile(new URL("../preview/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/audience-metrics.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/audience-history.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/audience-analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/audience-analytics.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-public-preview-data.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/platforms/youtube.svg", import.meta.url), "utf8"),
    readFile(new URL("../public/platforms/instagram.svg", import.meta.url), "utf8"),
    readFile(new URL("../public/platforms/tiktok.svg", import.meta.url), "utf8"),
    readFile(new URL("../public/platforms/x.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/CommentOpportunitiesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/comment-opportunities.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/comment-opportunities/feed.json", import.meta.url), "utf8"),
    readFile(new URL("../app/AudioTrendFeedView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/audio-trends.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/audio-trends/feed.json", import.meta.url), "utf8"),
    readFile(new URL("../app/SocialInlinePlayer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/social-inline-player.ts", import.meta.url), "utf8"),
  ]);

  assert.match(viteConfig, /const d1 = "DB"/);
  assert.match(schema, /socialAccounts/);
  assert.match(schema, /socialPosts/);
  assert.match(schema, /postMetricSnapshots/);
  assert.match(schema, /scanRuns/);
  assert.match(scanner, /youtube\.com\/feeds\/videos\.xml/);
  assert.match(scanner, /youtube\.com\/@LofiGirl\/shorts/);
  assert.match(scanner, /youtube\.com\/@LofiGirl\/posts/);
  assert.match(scanner, /vidéos longues et lives exclus/i);
  assert.match(scanner, /instagram\.com/);
  assert.match(scanner, /tiktok\.com/);
  assert.match(scanner, /x\.com/);
  assert.match(component, /label: "Tableau de bord"/);
  assert.match(component, /label: "Commentaires"/);
  assert.match(component, /initialCommentOpportunityFeed/);
  assert.match(component, /CommentOpportunitiesView/);
  assert.match(component, /Total followers/);
  assert.match(component, /Évolution quotidienne des followers/);
  assert.match(component, /Taux d’engagement/);
  assert.match(component, /className="audience-platform-grid"/);
  const audienceDashboard = component.slice(
    component.indexOf("function AudienceDashboard"),
    component.indexOf("function formatAudienceFollowers"),
  );
  assert.match(audienceDashboard, /useState<AudiencePeriodKey>\("30d"\)/);
  assert.match(audienceDashboard, /aria-label="P.riode du tableau de bord"/);
  assert.match(audienceDashboard, /AUDIENCE_PERIODS\.map/);
  assert.match(audienceDashboard, /engagementByPeriod\[periodKey\]/);
  assert.match(audienceDashboard, /useState<string \| null>\(null\)/);
  assert.match(audienceDashboard, /setClientNow\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(audienceDashboard, /Collecte planifiée/);
  assert.match(audienceDashboard, /contiguousExactAudienceSuffix\(points\)/);
  assert.match(audienceDashboard, /audienceGrowthForExactSuffix\(exactSuffix\)/);
  assert.match(
    audienceDashboard,
    /audiencePointsForPeriod\(platformHistory, periodEndAt, period\.days\)/,
  );
  assert.match(audienceDashboard, /periodEndAt = history\?\.generatedAt/);
  assert.match(audienceDashboard, /formatAudienceAge\(latestAgeDays\)/);
  assert.match(audienceDashboard, /<AudienceGrowthChart/);
  const audienceChart = component.slice(
    component.indexOf("function AudienceGrowthChart"),
    component.indexOf("function audiencePointsForPeriod"),
  );
  assert.match(audienceChart, /role="img"/);
  assert.equal((audienceChart.match(/tabIndex=\{0\}/g) ?? []).length, 1);
  assert.match(audienceChart, /<title>/);
  assert.match(audienceChart, /<desc>/);
  assert.match(audienceChart, /audience-chart-line-gap/);
  assert.match(audienceChart, /formatAudienceAxisValue\(line\.value, hasOnlyApproximatePoints\)/);
  assert.match(audienceChart, /trailingGapDays/);
  assert.doesNotMatch(audienceChart, /className="audience-chart-point"[\s\S]{0,180}tabIndex/);
  assert.doesNotMatch(component, /audience-spark-bars|sampleAudiencePoints/);
  assert.doesNotMatch(
    audienceDashboard,
    /\?\?\s*audienceGrowth\(platformHistory\)|\|\|\s*audienceGrowth\(platformHistory\)/,
  );
  assert.match(
    audienceDashboard,
    /<img src=\{`platforms\/\$\{platform\}\.svg`\} alt="" width="24" height="24" \/>/,
  );
  assert.doesNotMatch(audienceDashboard, /meta\.emoji/);
  assert.doesNotMatch(component, /Couverture maintenant|Analyse éditoriale|Posts à retenir|Comparaisons honnêtes/);
  assert.match(component, /label: "Tous les posts"/);
  assert.match(component, /label: "Posts recommandés"/);
  const recommendationNavSource = component.slice(
    component.indexOf("const RECOMMENDATION_NAV"),
    component.indexOf("const EDITORIAL_WORKFLOW_STORAGE_KEY"),
  );
  assert.match(
    recommendationNavSource,
    /id: "trends"[\s\S]*?id: "audio-trends"[\s\S]*?id: "ideas"[\s\S]*?id: "comments"/,
  );
  assert.match(component, /posts-platform-subnav/);
  assert.match(component, /recommendations-subnav/);
  assert.doesNotMatch(component, /NavSection|expandedNavSection|isExpanded/);
  assert.doesNotMatch(component, /className="nav-caret"|hidden=\{!isExpanded\}/);
  const primaryNavSource = component.slice(
    component.indexOf('<nav className="nav"'),
    component.indexOf('<div className="sidebar-foot"'),
  );
  assert.doesNotMatch(primaryNavSource, /aria-expanded|aria-controls/);
  assert.match(primaryNavSource, /aria-label=\{child\.label\}/);
  assert.match(primaryNavSource, /title=\{child\.label\}/);
  assert.match(component, /setView\("all"\)/);
  assert.match(component, /view === "top" && topPlatform === key/);
  assert.match(component, /onClick=\{\(\) => chooseTopPlatform\(key\)\}/);
  const postsPlatformSubnav = component.slice(
    component.indexOf('id="posts-platform-subnav"'),
    component.indexOf("{isRecommendationsParent ?"),
  );
  assert.match(postsPlatformSubnav, /className="nav-platform-logo"/);
  assert.match(postsPlatformSubnav, /src=\{`platforms\/\$\{key\}\.svg`\}/);
  assert.doesNotMatch(postsPlatformSubnav, /const count|\$\{count\}|nav-count/);
  assert.doesNotMatch(component, /className="nav-count"/);
  assert.doesNotMatch(component, /top-platform-picker/);
  assert.match(component, /SOCIAL_DURATION_FILTERS/);
  assert.doesNotMatch(component, /Règle de classement/);
  assert.doesNotMatch(component, /Chercher une accroche, un format/);
  assert.doesNotMatch(component, /publicRankingLabel/);
  assert.match(component, /activeInlineVideoId/);
  assert.match(component, /label: "Recommandations"/);
  assert.match(component, /label: "Roadmap"/);
  assert.match(component, /view === "comments"[\s\S]*?<CommentOpportunitiesView/);
  assert.match(component, /view === "trends"[\s\S]*?<TrendFeedView/);
  assert.match(component, /view === "audio-trends"[\s\S]*?<AudioTrendFeedView/);
  assert.match(component, /view === "ideas" \|\| view === "comments" \|\| view === "trends" \|\| view === "audio-trends"/);
  assert.match(component, /workspace && view === "ideas"[\s\S]*?<h2>Posts recommandés<\/h2>/);
  assert.match(component, /className="reco-status-tabs"/);
  assert.match(component, /🟡 À valider/);
  assert.match(component, /✓ Validées/);
  assert.match(component, /✕ Refusées/);
  assert.match(component, /↻ Nouvelles idées/);
  assert.match(component, /className="reco-grid"/);
  assert.doesNotMatch(component, /reco-platform-tabs|Filtrer les recommandations par plateforme/);
  assert.doesNotMatch(component, /recommendation-platform-grid|Déclinaisons possibles|Exécution commune/);
  assert.match(component, /className="reco-tags"/);
  assert.match(component, /L’idée/);
  assert.match(component, /Texte prêt à poster/);
  assert.match(component, /Inspiré de vos succès/);
  assert.match(component, /Les posts qui le prouvent/);
  assert.match(component, /Ce qu’on reprend/);
  assert.match(component, /Ce qu’on change/);
  assert.doesNotMatch(component, /Un même moment, une publication commune|Source \{index/);
  assert.doesNotMatch(component, /Afficher 10 idées de plus/);
  assert.match(component, /function RoadmapBoard/);
  assert.match(component, /Mois/);
  assert.match(component, /Année/);
  assert.match(component, /aria-label="Liste"/);
  assert.match(component, /aria-label="Calendrier"/);
  assert.match(component, /function RoadmapMiniMonth/);
  assert.match(component, /function RoadmapMonth/);
  assert.match(component, /function RoadmapList/);
  assert.match(component, /function RoadmapDayModal/);
  assert.doesNotMatch(component, /function RoadmapLegend/);
  assert.match(component, /Publication commune/);
  assert.doesNotMatch(previewEntry, /key=\{`\$\{workspace\.generatedAt\}:\$\{workspace\.posts\.length\}`\}/);
  assert.match(previewEntry, /public-history-summary\.json/);
  assert.match(previewEntry, /public-history-\$\{platform\}\.json/);
  assert.match(previewEntry, /publicHistorySummary\.totalPostCount/);
  assert.match(previewEntry, /publicHistorySummary\.formatCounts/);
  assert.match(previewEntry, /cache: "force-cache"/);
  assert.match(previewEntry, /RAW_TREND_FEED_URL/);
  assert.match(previewEntry, /initialTrendFeed=\{trendFeed\}/);
  assert.match(previewEntry, /initialAudioTrendFeed=\{audioTrendFeed\}/);
  assert.match(previewEntry, /RAW_AUDIO_TREND_FEED_URL/);
  assert.match(previewEntry, /RAW_VIDEO_TREND_STATUS_URL/);
  assert.match(previewEntry, /RAW_AUDIO_TREND_STATUS_URL/);
  assert.match(previewEntry, /initialVideoTrendScanStatus=\{videoTrendScanStatus\}/);
  assert.match(previewEntry, /initialAudioTrendScanStatus=\{audioTrendScanStatus\}/);
  assert.match(previewEntry, /refreshTrendScanStatuses/);
  assert.match(previewEntry, /window\.setInterval\(refreshAudioTrendFeed, 60 \* 60 \* 1_000\)/);
  assert.match(previewEntry, /RAW_AUDIENCE_HISTORY_URL/);
  assert.match(previewEntry, /initialAudienceHistory=\{audienceHistory\}/);
  assert.match(previewEntry, /refreshAudienceHistory/);
  assert.match(previewEntry, /RAW_AUDIENCE_HISTORY_URL = `\$\{liveDataBaseUrl\}\/audience-history\.json`/);
  assert.match(previewEntry, /RAW_AUDIENCE_ANALYTICS_URL/);
  assert.match(previewEntry, /audienceAnalytics=\{audienceAnalytics\}/);
  assert.match(previewEntry, /refreshAudienceAnalytics/);
  assert.match(
    previewEntry,
    /RAW_AUDIENCE_ANALYTICS_URL = `\$\{liveDataBaseUrl\}\/audience-analytics\.json`/,
  );
  assert.match(
    previewEntry,
    /window\.setInterval\(\s*refreshAudienceAnalytics,\s*60 \* 60 \* 1_000,?\s*\)/,
  );
  assert.match(publicPreviewBuilder, /assertAudienceAnalytics\(audienceAnalytics\)/);
  assert.match(
    publicPreviewBuilder,
    /writeJson\(resolve\(output, "audience-analytics\.json"\), audienceAnalytics\)/,
  );
  assert.match(audienceAnalyticsModel, /assertAudienceAnalytics/);
  assert.equal(JSON.parse(audienceAnalyticsSnapshot).version, 1);
  assert.match(previewEntry, /raw\.githubusercontent\.com\/dim75017\/youtube-radar-kx9v2m\/main\/social-app\/data/);
  assert.match(previewEntry, /RAW_AUDIO_TREND_FEED_URL = `\$\{liveDataBaseUrl\}\/audio-trends\/feed\.json`/);
  assert.match(previewEntry, /RAW_TREND_FEED_URL = `\$\{liveDataBaseUrl\}\/trends\/feed\.json`/);
  assert.match(previewEntry, /window\.setInterval\(refreshTrendFeed, 60 \* 60 \* 1_000\)/);
  assert.match(previewEntry, /visibilitychange/);
  assert.match(previewEntry, /RAW_COMMENT_OPPORTUNITIES_URL/);
  assert.match(previewEntry, /initialCommentOpportunityFeed=\{commentOpportunityFeed\}/);
  assert.match(
    previewEntry,
    /RAW_COMMENT_OPPORTUNITIES_URL = `\$\{liveDataBaseUrl\}\/comment-opportunities\/feed\.json`/,
  );
  assert.match(previewEntry, /window\.setInterval\(refreshCommentOpportunities, 60 \* 60 \* 1_000\)/);
  assert.match(audienceMetrics, /mean\(likes\+comments\)\/followers\*100/);
  assert.match(
    audienceMetrics,
    /key: "30d"[\s\S]*?label: "30 jours"[\s\S]*?key: "90d"[\s\S]*?label: "3 mois"[\s\S]*?key: "180d"[\s\S]*?label: "6 mois"[\s\S]*?key: "365d"[\s\S]*?label: "1 an"[\s\S]*?key: "all"[\s\S]*?label: "All time"/,
  );
  assert.doesNotMatch(audienceMetrics, /AUDIENCE_ENGAGEMENT_WINDOW_SIZE|toleranceDays/);
  const audienceSnapshot = JSON.parse(audienceHistory);
  assert.equal(audienceSnapshot.version, 2);
  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    assert.deepEqual(
      Object.keys(audienceSnapshot.platforms[platform].engagementByPeriod).sort(),
      ["30d", "90d", "180d", "365d", "all"].sort(),
    );
  }
  assert.match(audienceHistory, /"youtube"/);
  assert.match(audienceHistory, /"instagram"/);
  assert.match(audienceHistory, /"tiktok"/);
  assert.match(audienceHistory, /"x"/);
  for (const logo of [youtubeLogo, instagramLogo, tiktokLogo, xLogo]) {
    assert.match(logo, /^<svg\b/i);
    assert.match(logo, /<(?:path|rect|circle)\b/i);
    assert.doesNotMatch(logo, /<script\b|<foreignObject\b/i);
  }
  assert.match(youtubeLogo, /<path fill="#FFFFFF" d="M9\.545 8\.432/);
  assert.match(instagramLogo, /<radialGradient\b/);
  assert.match(instagramLogo, /stroke="#FFFFFF"/);
  assert.match(tiktokLogo, /<svg fill="#FFFFFF"/);
  assert.match(component, /resolvedPlatformCounts/);
  assert.match(component, /Les vrais compteurs sont déjà affichés/);
  assert.match(component, /PostDetailsModal/);
  assert.match(component, /post-visual-trigger/);
  assert.match(component, /inline-video-frame/);
  assert.match(component, /Plus d’informations/);
  assert.match(component, /Mesure au lancement/);
  assert.match(component, /metric_history/);
  assert.match(component, /label: "Trends vid.os"/);
  assert.match(component, /label: "Trends audio"/);
  assert.match(component, /TrendFeedView/);
  assert.match(component, /TrendReferenceMedia/);
  assert.match(component, /TrendDetailsModal/);
  assert.match(component, /trend-reference-card/);
  assert.match(component, /<h2>Trends vid.os<\/h2>/);
  assert.doesNotMatch(component, /Veille éditoriale quotidienne · focus Lofi Girl/);
  assert.doesNotMatch(component, /Repris par \{reuseCount\}\+ créateurs/);
  assert.doesNotMatch(component, /Vraie trend, pas simple post viral/);
  assert.doesNotMatch(component, /Preuve de reprise par plusieurs créateurs/);
  assert.doesNotMatch(component, /Nouveaux signaux vidéo détectés au dernier scan/);
  assert.doesNotMatch(component, /Dernier lot complet/);
  assert.doesNotMatch(component, /Retrouvée dans le scan du jour/);
  assert.match(component, /reuseEvidence\.posts\.map/);
  assert.match(component, /trendExampleSearchLinks\(trend\)\.map/);
  assert.match(component, /className="trend-example-section"/);
  assert.match(component, /platforms\/\$\{post\.platform\}\.svg/);
  assert.doesNotMatch(component, /reuseEvidence\.posts\.slice\(0,\s*3\)/);
  assert.match(component, /isActionableSocialTrend/);
  assert.match(component, /selectGirlFirstSocialTrends/);
  assert.match(component, /referencePost\?\.mediaType === "video"/);
  assert.match(
    component,
    /selectGirlFirstSocialTrends\([\s\S]*actionableTrends\.filter\(\(trend\) => trend\.referencePost\?\.mediaType === "video"\)[\s\S]*50/,
  );
  assert.match(component, /platformFilter === "all"/);
  assert.match(component, /return orderedVideoTrends/);
  assert.doesNotMatch(component, /\{selectedVideoTrends\.length\} cartes/);
  assert.doesNotMatch(component, /proposalCount/);
  assert.match(component, /trend\.proposals\.map/);
  assert.match(component, /trend-proposal-tabs/);
  assert.match(component, /dailyRotationIndex/);
  assert.match(component, /trend-card-source-title/);
  assert.match(component, /TREND_CHARACTER_META/);
  assert.doesNotMatch(component, /TREND_CHARACTER_FILTERS|characterFilter|Filtrer par univers|Tout l’univers/);
  assert.match(component, /label: "Lofi Girl"/);
  assert.match(component, /label: "Lofi Boy"/);
  assert.match(component, /Lofi Boy \/ Synthwave Boy/);
  assert.doesNotMatch(component, /character\.emoji.*character\.label.*trend\.territory/);
  assert.doesNotMatch(component, /Potentiel Lofi Girl|Adaptation Lofi Girl|Pourquoi Lofi Girl/);
  const trendModalSource = component.slice(
    component.indexOf("function TrendDetailsModal"),
    component.indexOf("function trendPlatformLabel"),
  );
  assert.ok(trendModalSource.indexOf("trend-lofi-adaptation") < trendModalSource.indexOf("post-details-summary"));
  assert.ok(trendModalSource.indexOf("trend-tone-tabs") < trendModalSource.indexOf("post-details-summary"));
  assert.doesNotMatch(trendModalSource, /post-observation-grid|trend-detail-grid|trend-tags|trend-proof-section|trend-caveat/);
  assert.doesNotMatch(trendModalSource, /Créateurs vérifiés|D’où vient le signal|Ce qui se répète|Bon moment|À produire/);
  assert.match(component, /trend-duration-badge/);
  assert.match(component, /post-grid top-ranking-grid trend-shorts-grid/);
  assert.match(styles, /\.trend-shorts-grid\s*\{[^}]*minmax\(300px,\s*1fr\)/);
  assert.match(styles, /\.trend-feed-controls\s*\{[^}]*grid-template-columns:\s*1fr;/);
  assert.match(styles, /\.trend-card-body \.post-card-title h3\s*\{[^}]*display:\s*block;[^}]*overflow:\s*visible;[^}]*-webkit-line-clamp:\s*unset;/);
  assert.match(styles, /\.trend-card-source-title\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;/);
  assert.match(styles, /\.audio-card-title h3\s*\{[^}]*display:\s*block;[^}]*overflow:\s*visible;[^}]*-webkit-line-clamp:\s*unset;/);
  assert.match(styles, /\.audio-proposal-copy\s*\{[^}]*display:\s*block;[^}]*overflow:\s*visible;[^}]*-webkit-line-clamp:\s*unset;/);
  assert.match(component, /activeProposal\?\.concept\s*\?\?\s*trend\.whyLofi/);
  assert.match(audioTrendView, /activeProposal\.concept/);
  assert.match(audioTrendView, /activeProposal\.copy/);
  assert.match(audioTrendView, /<h2>Trends audio<\/h2>/);
  assert.match(audioTrendView, /deriveAudioTrendGrowth/);
  assert.doesNotMatch(audioTrendView, /\{feed\.trends\.length\} cartes/);
  assert.doesNotMatch(audioTrendView, /proposalCount/);
  assert.doesNotMatch(audioTrendView, /Nouveaux sons détectés au dernier scan|Son candidat|Dernier lot complet|Retrouvé dans le scan du jour/);
  assert.match(audioTrendView, /compareAudioTrends\(left, right, freshnessCutoff\)/);
  assert.match(audioTrendView, /recentGrowth/);
  assert.match(audioTrendView, /currentRank/);
  assert.match(audioTrendView, /currentUses/);
  assert.match(audioTrendView, /freshnessTimestamp/);
  assert.match(audioTrendView, /growthFreshnessCutoff/);
  assert.match(audioTrendView, /Date\.parse\(derivedGrowth\.toCapturedAt\) >= growthFreshnessCutoff/);
  assert.match(audioTrendView, /trend\.proposals\.map/);
  assert.match(audioTrendView, /audio-proposal-tabs/);
  assert.match(audioTrendView, /dailyRotationIndex/);
  assert.doesNotMatch(audioTrendView, /Ouvrir l.audio/);
  assert.match(audioTrendView, /Croissance mesur.e d.s le prochain relev. comparable/);
  assert.match(audioTrendView, /platforms\/\$\{trend\.platform\}\.svg/);
  assert.match(audioTrendView, /activePlayerId/);
  assert.match(audioTrendView, /<SocialInlinePlayer/);
  assert.match(audioTrendView, /isAudioTrendThumbnailExpired/);
  assert.match(audioTrendView, /AudioReferencePreview/);
  assert.match(audioTrendView, /onError=\{\(\) =>/);
  assert.match(audioTrendView, /setFailed\(true\)/);
  assert.match(audioTrendView, /onLoad=\{\(\) => setLoaded\(true\)\}/);
  assert.doesNotMatch(audioTrendView, /<video|preload="metadata"|currentTime = 0\.05/);
  assert.match(audioTrendView, /audio-reference-play-overlay/);
  assert.match(audioTrendView, /audio-reference-fallback/);
  assert.match(audioTrendView, /audio-reference-waveform/);
  assert.match(audioTrendView, /Frame momentanément indisponible/);
  const inactiveAudioPreview = audioTrendView.slice(
    audioTrendView.indexOf('className="audio-reference-trigger"'),
    audioTrendView.indexOf('</button>', audioTrendView.indexOf('className="audio-reference-trigger"')),
  );
  assert.doesNotMatch(inactiveAudioPreview, /platforms\/\$\{trend\.platform\}\.svg/);
  assert.match(styles, /\.audio-reference-trigger > img\s*\{[\s\S]*?opacity:\s*0/);
  assert.match(styles, /\.audio-reference-trigger > img\.is-loaded\s*\{[\s\S]*?opacity:\s*1/);
  assert.match(styles, /\.audio-reference-fallback\s*\{[\s\S]*?linear-gradient/);
  assert.match(styles, /\.audio-reference-waveform\s*\{/);
  assert.match(styles, /\.audio-reference-play-overlay\s*\{/);
  assert.match(component, /activePlayerId/);
  assert.match(component, /<SocialInlinePlayer/);
  assert.match(socialInlinePlayerModel, /autoplay=0&muted=0/);
  assert.match(socialInlinePlayerModel, /enablejsapi=1/);
  assert.match(socialInlinePlayer, /event\.origin !== "https:\/\/www\.tiktok\.com"/);
  assert.match(socialInlinePlayer, /type: "unMute"/);
  assert.match(socialInlinePlayer, /player\.setVolume\(100\)/);
  assert.match(socialInlinePlayer, /onAutoplayBlocked/);
  assert.match(socialInlinePlayer, /inline-player-sound-fallback/);
  const directInstagramPlayer = socialInlinePlayer.slice(
    socialInlinePlayer.indexOf('platform === "instagram" && useInstagramVideo'),
    socialInlinePlayer.indexOf('if (platform === "instagram") {', socialInlinePlayer.indexOf('platform === "instagram" && useInstagramVideo') + 1),
  );
  assert.match(directInstagramPlayer, /<video/);
  assert.match(directInstagramPlayer, /controls/);
  assert.match(directInstagramPlayer, /playsInline/);
  assert.doesNotMatch(directInstagramPlayer, /autoPlay/);
  assert.doesNotMatch(directInstagramPlayer, /<iframe/);
  assert.match(audioTrendView, /playbackUrl=\{trend\.referenceVideo\.playbackUrl\}/);
  assert.match(audioTrendView, /playbackExpiresAt=\{trend\.referenceVideo\.playbackExpiresAt\}/);
  assert.match(socialInlinePlayer, /is-instagram-preview-only/);
  assert.match(styles, /is-instagram-preview-only iframe\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(audioTrendModel, /usageObservations/);
  assert.match(audioTrendModel, /same canonical source/i);
  const parsedAudioTrendFeed = JSON.parse(audioTrendFeed);
  assert.ok(parsedAudioTrendFeed.trends.length >= 50);
  assert.equal(
    new Set(parsedAudioTrendFeed.trends.map((trend) => trend.id)).size,
    parsedAudioTrendFeed.trends.length,
  );
  assert.match(component, /loading="lazy"/);
  assert.match(component, /Voir le post original/);
  assert.match(component, /hasMediaPreview \?/);
  assert.match(component, /text-only/);
  assert.doesNotMatch(component, /Lire ici|post-play-button/);
  assert.doesNotMatch(component, /Social & Community Intelligence OS|Snapshot public interactif|Générer les idées|VIEW_COPY/);
  assert.doesNotMatch(component, />\s*Tous\s*</);
  assert.match(component, /categoryFilters\(topPlatform\)\.map/);
  assert.match(component, /category-results/);
  assert.match(component, /className="category-results tone-all"/);
  const topRankingView = component.slice(
    component.indexOf('{workspace && view === "top"'),
    component.indexOf('{workspace && view === "all"'),
  );
  const rankingControlsStart = topRankingView.indexOf("top-ranking-controls");
  const rankingControlsEnd = topRankingView.indexOf("</section>", rankingControlsStart);
  const categoryResultsStart = topRankingView.indexOf("category-results", rankingControlsEnd);
  const categoryTitleStart = topRankingView.indexOf('id="active-category-title"', categoryResultsStart);
  assert.ok(rankingControlsStart >= 0);
  assert.ok(rankingControlsEnd > rankingControlsStart);
  assert.ok(categoryResultsStart > rankingControlsEnd);
  assert.ok(categoryTitleStart > categoryResultsStart);
  assert.match(component, /Toutes plateformes confondues/);
  assert.match(component, /allPlatformPosts\.slice\(0, visiblePostCount\)/);
  assert.match(component, /choices\.length \? "poll-card" : ""/);
  assert.doesNotMatch(component, /Historique visible chargé jusqu’au dernier lot/);
  assert.match(component, /TIKTOK_THUMBNAIL_CACHE/);
  assert.match(component, /TIKTOK_THUMBNAIL_REQUESTS/);
  assert.match(component, /sharedTikTokPreviewObserver/);
  assert.match(component, /IntersectionObserver/);
  assert.equal((component.match(/new IntersectionObserver/g) ?? []).length, 1);
  assert.match(socialInlinePlayer, /loading="lazy"/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /event\.key !== "Tab"/);
  const postCard = component.slice(
    component.indexOf("function PostCard"),
    component.indexOf("function PostMediaPreview"),
  );
  assert.doesNotMatch(postCard, /Pourquoi ça ressort/);
  assert.doesNotMatch(postCard, /score_explanation|performance_score|\/100/);
  assert.doesNotMatch(postCard, /Voir plus|Voir moins|post-text-expand|isTextExpanded|canExpandText/);
  assert.doesNotMatch(styles, /\.post-text-expand|\.post-media-caption\.is-expanded|\.post-text-content\.is-expanded/);
  const detailsModal = component.slice(component.indexOf("function PostDetailsModal"));
  assert.doesNotMatch(
    detailsModal,
    /Évolution mesurée|Un seul relevé disponible|Pourquoi ça ressort|Différence non isolée|Ce qui le différencie|À reproduire|Périmètre\s*:/,
  );
  assert.doesNotMatch(detailsModal, /metric-evolution|details-editorial-why|editorialAnalysis\.(mechanism|comparison|transferableLesson)/);
  assert.match(component, /parsePostRaw\(post\.raw_json\)/);
  assert.match(component, /raw\.pollVotes = post\.poll_votes/);
  assert.match(socialMedia, /youtube-nocookie\.com\/embed/);
  assert.match(socialMedia, /tiktok\.com\/player\/v1/);
  assert.match(socialMedia, /format === "short"/);
  assert.match(socialRanking, /Likes décroissants/);
  assert.match(socialRanking, /Vues décroissantes · likes indisponibles/);
  assert.doesNotMatch(socialRanking, /published_at|performance_score/);
  assert.doesNotMatch(styles, /\.nav-submenu\[hidden\]|\.nav-caret|\.nav-entry\.expanded/);
  assert.doesNotMatch(styles, /nav-meta/);
  assert.doesNotMatch(styles, /\.nav-count\b/);
  assert.match(styles, /\.nav-platform-logo\s*\{[\s\S]*?object-fit:\s*contain/);
  assert.match(styles, /--sidebar:\s*280px/);
  const navTextDeclarations = styles.match(/\.nav-text\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(navTextDeclarations, /white-space:\s*normal/);
  assert.doesNotMatch(navTextDeclarations, /text-overflow:\s*ellipsis|overflow:\s*hidden/);
  assert.match(styles, /--sidebar:\s*min\(88vw,\s*300px\)/);
  assert.match(styles, /\.post-visual\s*\{[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(styles, /\.inline-video-frame/);
  assert.match(styles, /\.post-details-modal/);
  assert.match(styles, /\.audience-period-control\s*\{/);
  assert.match(styles, /\.audience-period-tabs\s*\{/);
  assert.match(styles, /\.audience-platform-logo\s*\{/);
  assert.match(styles, /\.audience-platform-logo img\s*\{/);
  assert.match(styles, /\.audience-chart-viewport\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /\.audience-line-chart svg\s*\{[\s\S]*?min-width:\s*640px/);
  assert.match(styles, /\.audience-chart-grid text,[\s\S]*?font-size:\s*14px/);
  assert.doesNotMatch(styles, /\.audience-chart-point:focus/);
  const topRankingControlDeclarations = [
    ...styles.matchAll(/\.top-ranking-controls\s*\{([^}]*)\}/g),
  ].map((match) => match[1]);
  assert.ok(topRankingControlDeclarations.length > 0);
  for (const declarations of topRankingControlDeclarations) {
    assert.doesNotMatch(declarations, /\bposition\s*:\s*sticky\b/i);
    assert.doesNotMatch(declarations, /\btop\s*:\s*103px\b/i);
  }
  assert.match(styles, /\.comment-opportunity-grid \.comment-opportunity-visual\s*\{[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(styles, /\.comment-suggestion\s*\{/);
  assert.match(styles, /\.comment-copy-button\s*\{/);
  assert.match(styles, /\.reco-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(380px,\s*100%\),\s*1fr\)\)/);
  assert.match(styles, /\.reco-card\s*\{[\s\S]*?content-visibility:\s*auto/);
  assert.match(styles, /\.reco-card-main\s*>\s*h3\s*\{[\s\S]*?font-size:\s*18px/);
  assert.match(styles, /\.reco-proof-preview\s*\{/);
  assert.match(styles, /\.trend-feed-view\s*\{/);
  assert.match(styles, /\.trend-shorts-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(300px,\s*1fr\)\)/);
  assert.match(styles, /\.trend-shorts-grid \.trend-reference-visual\s*\{[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(styles, /\.trend-card-source-title\s*\{/);
  assert.match(styles, /\.trend-reuse-creators\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(170px,\s*1fr\)\)/);
  assert.match(styles, /\.trend-example-section\s*\{/);
  assert.match(styles, /\.trend-feed-heading\s*\{/);
  assert.match(styles, /\.trend-snapshot-pill\.is-late\s*\{/);
  assert.match(styles, /\.trend-duration-badge\s*\{/);
  assert.match(styles, /\.trend-details-modal\s*\{/);
  assert.match(styles, /\.recommendation-source-links a > img/);
  assert.match(styles, /\.recommendation-mechanic-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.reco-quick-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.roadmap-year-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(150px,\s*1fr\)\)/);
  assert.match(styles, /\.roadmap-calendar-shell\.platform-neutral\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.roadmap-month-days\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.social-post-card\s*\{[\s\S]*?display:\s*flex;[\s\S]*?height:\s*100%;[\s\S]*?flex-direction:\s*column;/);
  assert.match(styles, /\.social-post-card\.poll-card \.poll-choice-list\s*\{[\s\S]*?grid-auto-rows:\s*minmax\(36px, auto\)/);
  assert.match(styles, /\.poll-choice-list li\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal/);
  assert.doesNotMatch(styles, /\.social-post-card\.poll-card \.poll-choice-list\s*\{[\s\S]*?grid-template-rows:\s*repeat\(5, 36px\)/);
  assert.match(styles, /\.social-post-card footer\s*\{[\s\S]*?grid-template-columns:\s*max-content minmax\(0, 1fr\);/);
  assert.match(styles, /\.post-published-date\s*\{[\s\S]*?min-width:\s*max-content;[\s\S]*?justify-self:\s*start;[\s\S]*?width:\s*max-content;[\s\S]*?padding:\s*4px 12px 4px 10px;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /@media[\s\S]*?\.social-post-card\.compact\s*\{\s*display:\s*flex;[\s\S]*?\.social-post-card footer\s*\{\s*grid-template-columns:\s*max-content minmax\(0, 1fr\);/);
  assert.match(styles, /platform-youtube[\s\S]*?scale\(1\.8\)/);
  const explicitFontSizes = [...styles.matchAll(/font-size:\s*([0-9.]+)px/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(explicitFontSizes.length > 100);
  assert.ok(explicitFontSizes.every((size) => size >= 11));
  assert.doesNotMatch(component, /tous affichés/i);
  assert.match(durations, /All time/);
  assert.match(durations, /180d/);
  assert.match(component, /topFilteredPosts\.map/);
  assert.doesNotMatch(component, /slice\(0,\s*12\)|Top 12 affiché/);
  assert.match(formats, /Commentaires/);
  assert.match(formats, /Communauté · image/);
  assert.match(component, /commentaires écrits par @LofiGirl/i);
  assert.match(publicHistory, /isInScopeSocialPost/);
  assert.match(publicHistory, /seuls les Shorts et posts Communauté sont inclus/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  assert.match(commentOpportunities, /Commentaires à poster maintenant/);
  assert.match(commentOpportunities, /Drôle/);
  assert.match(commentOpportunities, /Smart/);
  assert.match(commentOpportunities, /Complice/);
  assert.match(commentOpportunities, /Copier le commentaire/);
  assert.match(commentOpportunities, /À relire/);
  assert.match(commentOpportunities, /Ouvrir ↗/);
  assert.match(commentOpportunities, /✓ Fait/);
  assert.match(commentOpportunities, /Passer/);
  assert.match(commentOpportunities, /lofi-social-radar:comment-opportunity-statuses:v1/);
  assert.match(commentOpportunities, /platforms\/\$\{opportunity\.platform\}\.svg/);
  assert.doesNotMatch(commentOpportunities, /new IntersectionObserver/);
  assert.doesNotMatch(commentOpportunities, /fetch\([^)]*(?:comment|reply)|postComment|publishComment/i);
  assert.match(commentOpportunityModel, /hasCommentOpportunityAccelerationEvidence/);
  assert.match(commentOpportunityModel, /comments\.length !== 3/);
  assert.match(commentOpportunityModel, /tones\.size !== VALID_TONES\.size/);
  // The board is a decision surface, so the two things a CM reads before
  // copying anything have to survive a refactor: how long the window stays
  // open, and whether the proposals were written or are placeholders.
  assert.match(commentOpportunities, /commentOpportunityGoldenWindow/);
  assert.match(commentOpportunities, /commentsSource === "fallback"/);
  assert.match(commentOpportunities, /drops en cours/);
  const commentSnapshot = JSON.parse(commentOpportunityFeed);
  assert.equal(commentSnapshot.version, 2);
  assert.ok(commentSnapshot.watchlistAccountCount > 0);
  assert.ok(commentSnapshot.opportunities.length >= 20);
  assert.deepEqual(
    [...new Set(commentSnapshot.opportunities.map((item) => item.platform))].sort(),
    ["instagram", "tiktok", "x", "youtube"],
  );
});

test("checks editorial trend freshness in the pipeline without exposing scan internals", async () => {
  const [
    socialComponent,
    audioTrendView,
    trendHealthModel,
    healthScript,
    healthWorkflow,
    videoRefreshWorkflow,
    audioRefreshWorkflow,
  ] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AudioTrendFeedView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/trend-health.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-trends-health.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/social-check-trends-health.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/social-refresh-video-trends.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/social-refresh-audio-trends.yml", import.meta.url), "utf8"),
  ]);

  const videoTrendView = socialComponent.slice(
    socialComponent.indexOf("function TrendFeedView"),
    socialComponent.indexOf("function TrendDetailsModal"),
  );
  for (const view of [videoTrendView, audioTrendView]) {
    assert.match(view, /feed\?\.capturedAt|feed\.capturedAt/);
    assert.doesNotMatch(view, /isTrendEditorialScanLate/);
    assert.doesNotMatch(view, /Dernier lot complet|Scan quotidien|scan du jour|candidats|Actualisé/);
  }
  assert.match(trendHealthModel, /TREND_EDITORIAL_SCAN_MAX_AGE_HOURS = 26/);
  assert.match(healthScript, /discoveryAudit\.candidateCount doit être >=/);
  assert.match(healthScript, /discoveryAudit\.qualifiedInventoryCount doit être >=/);
  assert.match(healthScript, /discoveryAudit incomplet/);
  assert.match(healthScript, /feed\.capturedAt ne correspond pas au scan qualifié publié/);
  assert.match(healthScript, /pool .*inchangé/);
  assert.doesNotMatch(healthScript, /\bfetch\s*\(|thumbnail|playback|<video|SocialInlinePlayer/i);
  assert.match(healthWorkflow, /cron: "7 \*\/6 \* \* \*"/);
  assert.match(healthWorkflow, /contents: read/);
  assert.doesNotMatch(healthWorkflow, /contents: write|actions: write|git push|workflow run/i);
  for (const workflow of [videoRefreshWorkflow, audioRefreshWorkflow]) {
    assert.match(workflow, /working-directory: social-app/);
    assert.doesNotMatch(workflow, /actions: write|gh-pages|publish-public-preview/);
    assert.match(workflow, /id: commit/);
  }
});

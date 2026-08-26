import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("consolidates audience analytics into one truthful selectable chart", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const explorer = component.slice(
    component.indexOf("type NativeAnalyticsMetricMeta"),
    component.indexOf("function TrendFeedView"),
  );
  const dashboard = component.slice(
    component.indexOf("function AudienceDashboard"),
    component.indexOf("type NativeAnalyticsMetricMeta"),
  );
  const toolbar = dashboard.slice(
    dashboard.indexOf('className="audience-dashboard-toolbar"'),
    dashboard.indexOf('className="audience-platform-grid"'),
  );

  assert.match(component, /audienceAnalytics\?: AudienceAnalytics \| null/);
  assert.match(component, /audienceDemographics\?: AudienceDemographics \| null/);
  assert.match(component, /analytics=\{audienceAnalytics\}/);
  assert.match(component, /demographics=\{audienceDemographics\}/);
  assert.match(explorer, /function AudienceAnalyticsExplorer/);
  assert.match(component, /useState<Platform>\("youtube"\)/);
  assert.match(explorer, /youtube: "followersNet"/);
  assert.match(explorer, /tiktok: "followersNet"/);
  assert.match(explorer, /x: "followersNet"/);
  assert.match(explorer, /aria-label="Plateforme du graphique"/);
  assert.match(explorer, /PLATFORM_ORDER\.map/);
  assert.match(explorer, /aria-pressed=\{platform === activePlatform\}/);
  assert.match(explorer, /const AUDIENCE_CHART_PERIODS = \[/);
  const periodDeclarations = component
    .match(/const AUDIENCE_CHART_PERIODS = \[([\s\S]*?)\] as const/)?.[1]
    ?.matchAll(/\{ key: "([^"]+)", label: "([^"]+)", days: (\d+|null), snapshotKey:/g);
  assert.deepEqual(
    [...(periodDeclarations ?? [])].map((match) => [match[1], match[2], match[3]]),
    [
      ["30d", "30 jours", "30"],
      ["90d", "90 jours", "90"],
      ["180d", "180 jours", "180"],
      ["360d", "360 jours", "360"],
      ["all", "All time", "null"],
    ],
  );
  assert.match(dashboard, /const \[periodKey, setPeriodKey\] = useState<AudienceChartPeriodKey>\("30d"\)/);
  assert.match(toolbar, /className="audience-period-control"/);
  assert.match(toolbar, /className="audience-period-tabs"/);
  assert.match(toolbar, /aria-label="Période du tableau de bord"/);
  assert.match(toolbar, /AUDIENCE_CHART_PERIODS\.map/);
  assert.match(toolbar, /aria-pressed=\{option\.key === periodKey\}/);
  assert.match(toolbar, /onClick=\{\(\) => setPeriodKey\(option\.key\)\}/);
  assert.ok(toolbar.indexOf("audience-dashboard-heading") < toolbar.indexOf("audience-period-control"));
  assert.doesNotMatch(explorer, /useState<AudienceChartPeriodKey>|setChartPeriodKey|Période du graphique|audience-chart-period-tabs/);
  assert.match(dashboard, /<AudienceAnalyticsExplorer[\s\S]*?periodKey=\{periodKey\}/);
  assert.match(explorer, /periodKey: AudienceChartPeriodKey/);
  assert.match(explorer, /AUDIENCE_CHART_PERIODS\.find\(\(option\) => option\.key === periodKey\)/);
  assert.match(explorer, /aria-label=\{`Métrique du graphique/);
  assert.match(explorer, /availableMetricWindows\.map/);
  assert.match(explorer, /aria-pressed=\{metric === activeMetric\}/);
  assert.equal((component.match(/<AudienceNativeMetricChart\b/g) ?? []).length, 1);
  assert.doesNotMatch(component, /function AudienceGrowthChart/);
  assert.doesNotMatch(component, /function AudienceNativePlatformCard/);
  assert.doesNotMatch(component, /audience-native-platform-grid/);
  assert.doesNotMatch(component, /audience-evolution-block/);
  assert.doesNotMatch(dashboard, /Collecte planifiée/);
  assert.match(dashboard, /calculatePlatformEngagementWindow\([\s\S]*?period\.days/);
  assert.match(dashboard, /audiencePointsForPeriod\(platformHistory, periodEndAt, period\.days\)/);
  assert.match(dashboard, /nativeAnalyticsDailyForPeriod\([\s\S]*?period\.days/);

  assert.match(explorer, /function audienceMetricSeries/);
  assert.match(explorer, /function audienceMetricEndDate/);
  assert.match(explorer, /function audienceHistoryPointsForPeriod/);
  assert.match(explorer, /const endDate = activeWindow\?\.endDate/);
  assert.match(explorer, /Toute la plage native importée/);
  assert.match(explorer, /Agrégat officiel · \$\{periodLabel\}/);
  assert.match(explorer, /metric === "followersTotal"/);
  assert.match(explorer, /historyPoints/);
  assert.match(explorer, /point\.metrics\[metric\]/);
  assert.match(explorer, /byDate\.set\(date/);
  assert.match(explorer, /elapsedDays === 1 && comparablePrecision/);
  assert.match(explorer, /Données réelles · jours absents non reliés/);
  assert.doesNotMatch(explorer, /fillMissing|interpolate|interpolation linéaire/i);

  assert.match(styles, /\.audience-platform-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4/);
  assert.match(styles, /\.main\.main-dashboard\s*\{[\s\S]*?padding-bottom:\s*8px/);
  assert.match(styles, /\.audience-dashboard-toolbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.audience-period-control\s*\{[\s\S]*?justify-content:\s*flex-end/);
  assert.match(styles, /\.audience-period-tabs/);
  assert.match(styles, /\.audience-explorer-platform-tabs/);
  assert.match(styles, /\.audience-explorer-metrics/);
  assert.match(styles, /\.audience-native-chart-empty,[\s\S]*?min-height:\s*150px/);
  assert.match(styles, /\.audience-native-chart-viewport\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /\.audience-demographics-grid\s*\{[\s\S]*?grid-template-columns:\s*1\.12fr 1fr 0\.84fr/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.audience-platform-grid/);
  assert.doesNotMatch(styles, /\.audience-chart-viewport|\.audience-native-platform-grid/);
});

test("keeps the audience curve clean and reveals the exact hovered value instantly", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const chart = component.slice(
    component.indexOf("function AudienceNativeMetricChart"),
    component.indexOf("function isNativeAnalyticsValue"),
  );

  assert.match(
    chart,
    /const \[hovered(?:Point)?Index, setHovered(?:Point)?Index\] = useState<number \| null>\(null\)/,
  );
  assert.match(chart, /onPointerMove=/);
  assert.match(chart, /onPointerLeave=/);
  assert.match(chart, /setHovered(?:Point)?Index\(null\)/);
  assert.match(chart, /getBoundingClientRect\(\)/);
  assert.match(chart, /event\.clientX/);

  // La courbe reste lisible : aucun marqueur permanent pour chaque observation.
  assert.equal((chart.match(/<circle\b/g) ?? []).length, 1);
  assert.doesNotMatch(chart, /coordinates\.map\([\s\S]{0,600}<circle\b/);
  assert.match(chart, /hoveredCoordinate \?[\s\S]*?<circle\b/);

  // Le seul point visible accompagne un popup qui expose la date et la valeur réelles.
  const tooltipStart = chart.indexOf('role="tooltip"');
  assert.ok(tooltipStart >= 0, "the hovered point must expose a semantic tooltip");
  const tooltipSource = chart.slice(Math.max(0, tooltipStart - 1_400), tooltipStart + 2_000);
  assert.match(tooltipSource, /formatNativeAnalyticsDate\(/);
  assert.match(tooltipSource, /formatAudienceSeriesValue\(/);
  assert.match(tooltipSource, /audience-native-chart-tooltip/);

  // Le tracé exploite la hauteur disponible au lieu de figer un petit viewBox.
  assert.match(chart, /useState\(\{ width: 940, height: 180 \}\)/);
  assert.match(chart, /const plotTop = 12/);
  assert.match(chart, /const plotBottom = height - 40/);
  assert.match(chart, /bottomReserve/);
  assert.match(chart, /Math\.max\(120, Math\.min\(280, availableHeight\)\)/);
  assert.match(styles, /\.main\.main-dashboard\s*\{[\s\S]*?padding-bottom:\s*8px/);

  // Les cinq filtres exacts du graphe restent disponibles après l'amélioration du survol.
  assert.match(component, /key: "30d", label: "30 jours", days: 30/);
  assert.match(component, /key: "90d", label: "90 jours", days: 90/);
  assert.match(component, /key: "180d", label: "180 jours", days: 180/);
  assert.match(component, /key: "360d", label: "360 jours", days: 360/);
  assert.match(component, /key: "all", label: "All time", days: null/);
});

test("shows native demographic dimensions below the chart and follows the selected platform", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const explorer = component.slice(
    component.indexOf("function AudienceAnalyticsExplorer"),
    component.indexOf("function audienceMetricSeries"),
  );

  assert.match(explorer, /const demographicPlatform = demographics\?\.platforms\[activePlatform\] \?\? null/);
  assert.match(explorer, /<AudienceDemographicsPanel/);
  assert.match(explorer, /snapshot=\{demographicPlatform\}/);
  assert.ok(
    explorer.indexOf("<AudienceDemographicsPanel") > explorer.indexOf("audience-native-chart-shell"),
    "the demographic section must remain below the curve",
  );
  assert.match(explorer, /Principaux pays/);
  assert.match(explorer, /Répartition par âge/);
  assert.match(explorer, /Répartition par genre/);
  assert.match(explorer, /flags\/\$\{entry\.countryCode\?\.toLowerCase\(\) \?\? "globe"\}\.svg/);
  assert.match(explorer, /Localisation non disponible pour/);
  assert.match(explorer, /Âge non disponible pour/);
  assert.match(explorer, /Genre non disponible pour/);
  assert.match(styles, /\.audience-demographics\s*\{/);
  assert.doesNotMatch(explorer, /audience-demographic-stack/);
  assert.doesNotMatch(explorer, /audience-demographic-empty" role="status"/);
  assert.match(explorer, /<span className="audience-demographic-bar" aria-hidden="true">/);
  assert.match(styles, /\.audience-demographic-card\.kind-ages \.audience-demographic-list\s*\{[\s\S]*?repeat\(2/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.audience-demographics-grid\s*\{[\s\S]*?repeat\(2/);
});

test("keeps sparse Instagram observations truthful and falls back without fabricating a curve", async () => {
  const [component, analyticsRaw, historyRaw] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/audience-analytics.json", import.meta.url), "utf8"),
    readFile(new URL("../data/audience-history.json", import.meta.url), "utf8"),
  ]);
  const analytics = JSON.parse(analyticsRaw);
  const history = JSON.parse(historyRaw);
  const explorer = component.slice(
    component.indexOf("type NativeAnalyticsMetricMeta"),
    component.indexOf("function TrendFeedView"),
  );
  const instagramDaily = analytics.platforms.instagram.daily;

  for (const [index, point] of instagramDaily.entries()) {
    assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/, `Instagram daily row ${index} needs a real date`);
    assert.ok(
      Object.values(point.metrics).some((value) => value !== null),
      `Instagram daily row ${index} cannot be an empty synthetic placeholder`,
    );
    for (const metric of ["followersTotal", "followersNet", "newFollowers", "unfollows"]) {
      const value = point.metrics[metric];
      assert.ok(
        value === null || Number.isInteger(value),
        `Instagram ${metric} must be an integer or null`,
      );
    }
    assert.ok(point.provenance?.provider);
    assert.ok(point.provenance?.collectedAt);
    assert.ok(point.provenance?.sourceUrl);
    assert.ok(point.provenance?.basis);
  }

  const dailyDates = instagramDaily.map((point) => point.date);
  assert.equal(new Set(dailyDates).size, dailyDates.length, "Instagram daily dates must stay unique");
  assert.deepEqual(dailyDates, dailyDates.toSorted(), "Instagram daily rows must stay chronological");
  for (const observation of history.platforms.instagram.observations) {
    assert.ok(Number.isInteger(observation.followers));
    assert.ok(observation.precision, "every displayed Instagram point needs observed precision");
    assert.ok(observation.sourceUrl, "every displayed Instagram point needs its native source");
  }

  if (instagramDaily.length === 0) {
    assert.ok(analytics.platforms.instagram.periods["30d"]);
    assert.ok(analytics.platforms.instagram.periods["90d"]);
  }
  assert.match(
    explorer,
    /activeSeries\.length === 0 && activeSummary\.basis === "period"/,
    "a real aggregate remains available when no daily curve exists",
  );
  assert.match(explorer, /La plateforme ne fournit pas de courbe quotidienne exportable/);
  assert.match(explorer, /elapsedDays === 1 && comparablePrecision/);
  assert.doesNotMatch(explorer, /fillMissing|interpolat(?:e|ion)|syntheticPoint/i);
});

test("uses the native daily Instagram follows series as the default Instagram curve", async () => {
  const component = await readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8");
  assert.match(
    component,
    /instagram:\s*\[\s*"newFollowers",\s*"followersTotal"/,
  );
  assert.match(
    component,
    /instagram:\s*"newFollowers"/,
  );
  assert.match(
    component,
    /elapsedCalendarDays\(growth\.from\.capturedAt, growth\.to\.capturedAt\)/,
  );
  assert.match(component, /jour\$\{observedGrowthDays > 1 \? "s" : ""\} observé/);
});

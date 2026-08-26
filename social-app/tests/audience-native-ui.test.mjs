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

  assert.match(component, /audienceAnalytics\?: AudienceAnalytics \| null/);
  assert.match(component, /analytics=\{audienceAnalytics\}/);
  assert.match(explorer, /function AudienceAnalyticsExplorer/);
  assert.match(explorer, /useState<Platform>\("youtube"\)/);
  assert.match(explorer, /youtube: "followersNet"/);
  assert.match(explorer, /tiktok: "followersTotal"/);
  assert.match(explorer, /x: "followersNet"/);
  assert.match(explorer, /aria-label="Plateforme du graphique"/);
  assert.match(explorer, /PLATFORM_ORDER\.map/);
  assert.match(explorer, /aria-pressed=\{platform === activePlatform\}/);
  assert.match(explorer, /const AUDIENCE_CHART_PERIODS = \[/);
  assert.match(explorer, /key: "30d", label: "30 jours", days: 30/);
  assert.match(explorer, /key: "90d", label: "90 jours", days: 90/);
  assert.match(explorer, /key: "360d", label: "360 jours", days: 360/);
  assert.match(explorer, /key: "all", label: "All time", days: null/);
  assert.match(explorer, /useState<AudienceChartPeriodKey>\("30d"\)/);
  assert.match(explorer, /aria-label="Période du graphique"/);
  assert.match(explorer, /aria-pressed=\{option\.key === chartPeriodKey\}/);
  assert.match(explorer, /aria-label=\{`Métrique du graphique/);
  assert.match(explorer, /availableMetrics\.map/);
  assert.match(explorer, /aria-pressed=\{metric === activeMetric\}/);
  assert.equal((component.match(/<AudienceNativeMetricChart\b/g) ?? []).length, 1);
  assert.doesNotMatch(component, /function AudienceGrowthChart/);
  assert.doesNotMatch(component, /function AudienceNativePlatformCard/);
  assert.doesNotMatch(component, /audience-native-platform-grid/);
  assert.doesNotMatch(component, /audience-evolution-block/);

  assert.match(explorer, /function audienceMetricSeries/);
  assert.match(explorer, /function audienceMetricEndDate/);
  assert.match(explorer, /function audienceHistoryPointsForPeriod/);
  assert.match(explorer, /const endDate = activeMetric/);
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
  assert.match(styles, /\.audience-dashboard-toolbar\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.audience-explorer-platform-tabs/);
  assert.match(styles, /\.audience-chart-period-tabs/);
  assert.match(styles, /\.audience-explorer-metrics/);
  assert.match(styles, /\.audience-native-chart-empty,[\s\S]*?min-height:\s*150px/);
  assert.match(styles, /\.audience-native-chart-viewport\s*\{[\s\S]*?overflow-x:\s*auto/);
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
  assert.match(chart, /Math\.max\(180, availableHeight\)/);
  assert.match(styles, /\.main\.main-dashboard\s*\{[\s\S]*?padding-bottom:\s*8px/);

  // Les quatre filtres du graphe restent disponibles après l'amélioration du survol.
  assert.match(component, /key: "30d", label: "30 jours", days: 30/);
  assert.match(component, /key: "90d", label: "90 jours", days: 90/);
  assert.match(component, /key: "360d", label: "360 jours", days: 360/);
  assert.match(component, /key: "all", label: "All time", days: null/);
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

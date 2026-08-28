import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps follower values integral and fits the chart inside the remaining viewport", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const chart = component.slice(
    component.indexOf("function AudienceNativeMetricChart"),
    component.indexOf("function isNativeAnalyticsValue"),
  );
  const formatters = component.slice(
    component.indexOf("function formatNativeAnalyticsMetric"),
    component.indexOf("function formatAudiencePercent"),
  );

  assert.match(chart, /chartViewportRef/);
  assert.match(chart, /new ResizeObserver\(resizeChart\)/);
  assert.match(chart, /window\.innerHeight - viewport\.getBoundingClientRect\(\)\.top - bottomReserve - 34/);
  assert.match(chart, /Math\.max\(180, Math\.min\(Math\.round\(window\.innerHeight \* 0\.72\), availableHeight\)\)/);
  assert.match(chart, /style=\{\{ height: `\$\{height\}px` \}\}/);
  assert.match(chart, /buildAudienceChartAxis\(paddedMinimum, paddedMaximum/);
  assert.match(chart, /const gridLines = axis\.ticks\.map/);
  assert.match(chart, /axisStep: axis\.step/);
  assert.match(chart, /formatAudienceAxisTick\(line\.value, metric, axisStep\)/);
  assert.doesNotMatch(chart, /maximum - ratio \* valueSpan/);

  assert.match(formatters, /metric === "followersTotal"/);
  assert.match(formatters, /metric === "followersNet"/);
  assert.match(formatters, /metric === "newFollowers"/);
  assert.match(formatters, /metric === "unfollows"/);
  assert.match(formatters, /metric === "followersNet" \|\| metric === "newFollowers"/);
  assert.match(formatters, /Math\.round\(Math\.abs\(value\)\)/);
  assert.match(formatters, /maximumFractionDigits: 0/);
  assert.match(formatters, /function formatAudienceAxisTick/);
  assert.match(formatters, /if \(normalizedValue === 0\) return "0"/);
  assert.match(formatters, /metric === "followersNet" \|\| metric === "newFollowers" \? `\+\$\{formatted\}`/);
  assert.doesNotMatch(
    formatters.slice(formatters.indexOf("function formatAudienceDelta")),
    /notation:\s*absolute >= 1_000_000 \? "compact"/,
  );

  const chartText = styles.match(
    /\.audience-native-chart-grid text,[\s\S]*?\.audience-native-chart-date\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";
  assert.match(chartText, /font-size:\s*9px/);
  assert.match(styles, /\.audience-native-chart-tooltip-date\s*\{[\s\S]*?font-size:\s*8px/);
  assert.match(styles, /\.audience-native-chart-tooltip-value\s*\{[\s\S]*?font-size:\s*11px/);
  assert.match(styles, /\.audience-period-control-chart \.audience-period-tabs button\s*\{[\s\S]*?min-width:\s*74px[\s\S]*?font-size:\s*11px/);
  assert.match(styles, /\.audience-explorer-chart-controls\s*\{[\s\S]*?align-items:\s*center[\s\S]*?justify-content:\s*space-between/);
  assert.match(styles, /\.audience-dashboard-toolbar\s*\{[\s\S]*?margin-bottom:\s*12px/);
  assert.match(styles, /\.audience-explorer-summary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(82px, 1fr\)\)/);
  assert.match(styles, /\.audience-explorer\s*\{[\s\S]*?margin-top:\s*0/);
  assert.match(styles, /\.audience-overview-screen\s*\{[\s\S]*?padding:\s*12px 14px/);
  assert.match(styles, /\.audience-native-chart-shell\s*\{[\s\S]*?margin-top:\s*8px/);
  assert.match(styles, /\.audience-demographics\s*\{[\s\S]*?margin-top:\s*14px[\s\S]*?padding:\s*14px 16px 16px/);
  assert.match(styles, /\.audience-demographic-card\s*\{[\s\S]*?min-height:\s*178px[\s\S]*?padding:\s*12px/);
  assert.match(styles, /\.audience-demographic-list li\s*\{[\s\S]*?min-height:\s*20px[\s\S]*?font-size:\s*clamp\(11px, 0\.78vw, 12px\)/);
  assert.match(styles, /\.audience-demographic-bar\s*\{[\s\S]*?height:\s*5px/);
  assert.match(component, /className="audience-overview-screen"/);
  assert.match(component, /bottomReserve=\{24\}/);
  assert.match(styles, /\.audience-overview-screen\s*\{[\s\S]*?min-height:\s*calc\(100dvh - 118px\)/);
  assert.match(styles, /\.audience-demographics\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(styles, /\.audience-demographic-pie-layout\s*\{[\s\S]*?clamp\(148px, 13vw, 190px\)/);
  assert.match(styles, /\.audience-demographic-pie\s*\{[\s\S]*?max-width:\s*190px/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 940px\)/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 820px\)[\s\S]*?\.main\.main-dashboard\s*\{[\s\S]*?padding-bottom:\s*0/);
});

test("syncs the sidebar platform selector with the active account summary and follower-change default", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const dashboard = component.slice(
    component.indexOf("function AudienceDashboard"),
    component.indexOf("type NativeAnalyticsMetricMeta"),
  );
  const explorer = component.slice(
    component.indexOf("function AudienceAnalyticsExplorer"),
    component.indexOf("function audienceMetricSeries"),
  );

  assert.match(component, /const \[audiencePlatform, setAudiencePlatform\] = useState<Platform>\("youtube"\)/);
  assert.match(dashboard, /const \[periodKey, setPeriodKey\] = useState<AudienceChartPeriodKey>\("30d"\)/);
  assert.doesNotMatch(dashboard, /aria-label="Période du tableau de bord"/);
  assert.match(dashboard, /activePlatform: Platform/);
  assert.match(dashboard, /useState<Record<Platform, AudienceAnalyticsMetricKey>>/);
  assert.match(dashboard, /const requestedMetric = requestedMetrics\[activePlatform\]/);
  assert.match(dashboard, /\[activePlatform\]: metric/);
  assert.doesNotMatch(dashboard, /audience-platform-grid|audience-platform-card/);
  assert.match(dashboard, /activePlatform=\{activePlatform\}/);
  assert.doesNotMatch(dashboard, /selectAudiencePlatform|onSelectPlatform/);
  assert.match(dashboard, /onSelectPeriod=\{setPeriodKey\}/);
  assert.match(dashboard, /periodKey=\{periodKey\}/);
  assert.match(component, /id="analytics-platform-subnav"/);
  assert.match(component, /onClick=\{\(\) => chooseAudiencePlatform\(key\)\}/);
  assert.match(component, /activePlatform=\{audiencePlatform\}/);

  assert.match(component, /youtube:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /instagram:\s*\[\s*"newFollowers",\s*"followersTotal"/);
  assert.match(component, /tiktok:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /x:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /youtube:\s*"followersNet"/);
  assert.match(component, /instagram:\s*"newFollowers"/);
  assert.match(component, /tiktok:\s*"followersNet"/);
  assert.match(component, /x:\s*"followersNet"/);
  assert.doesNotMatch(component, /Plateforme du graphique|audience-explorer-platform-tabs|onSelectPlatform/);
  assert.match(explorer, /availableMetricWindows\.find\(\(window\) => window\.metric === requestedMetric\)/);
  assert.match(explorer, /className="audience-period-control audience-period-control-chart"/);
  assert.match(explorer, /onClick=\{\(\) => onSelectPeriod\(option\.key\)\}/);
  assert.match(explorer, /className="audience-explorer-chart-controls"[\s\S]*?className="audience-explorer-metrics"[\s\S]*?className="audience-period-control audience-period-control-chart"/);
  assert.doesNotMatch(explorer, /audience-native-chart-heading|Évolution quotidienne|Valeur disponible/);
  assert.match(explorer, /className="audience-explorer-summary"/);
  assert.doesNotMatch(explorer, /className="audience-explorer-profile"/);
  assert.equal((explorer.match(/className="audience-explorer-summary-kpi"/g) ?? []).length, 6);
  assert.match(explorer, /<span>Nouveaux followers<\/span>/);
  assert.match(explorer, /<span>Vues \/ impressions<\/span>/);
  assert.match(explorer, /<span>Reach<\/span>/);
  assert.match(explorer, /<span>Engagements<\/span>/);
  assert.doesNotMatch(explorer, /Variation nette des followers|Variation followers/);
  assert.match(explorer, /activePlatform === "instagram" \? null : observedFollowerGrowth\?\.followersDelta/);
  assert.match(explorer, /calculatePlatformEngagementWindow\([\s\S]*?periodDays/);
  assert.match(explorer, /audiencePointsForPeriod\([\s\S]*?periodDays/);
  assert.match(explorer, /followersDeltaPeriodLabel = followerChangeSummary[\s\S]*?periodLabel/);
  assert.match(explorer, /followersDelta === null \|\| followersDelta === 0[\s\S]*?followersDelta < 0[\s\S]*?"negative"[\s\S]*?"positive"/);
  assert.doesNotMatch(explorer, /const \[chartPeriodKey|setChartPeriodKey|Période du graphique/);

  assert.doesNotMatch(styles, /\.audience-explorer-platform-tabs/);
  assert.match(styles, /\.audience-explorer-summary-kpi\s*\{/);
  assert.match(styles, /\.audience-explorer-summary-kpi > strong\s*\{[\s\S]*?color:\s*#fff/);
  assert.match(styles, /\.audience-explorer-summary-kpi > strong\.positive\s*\{[\s\S]*?color:\s*#8ee7ae/);
  assert.match(styles, /\.audience-explorer-summary-kpi > strong\.negative\s*\{[\s\S]*?color:\s*var\(--red\)/);
});

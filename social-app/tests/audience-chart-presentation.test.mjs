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
  assert.match(chart, /Math\.max\(120, Math\.min\(280, availableHeight\)\)/);
  assert.match(chart, /style=\{\{ height: `\$\{height\}px` \}\}/);

  assert.match(formatters, /metric === "followersTotal"/);
  assert.match(formatters, /metric === "followersNet"/);
  assert.match(formatters, /metric === "newFollowers"/);
  assert.match(formatters, /metric === "unfollows"/);
  assert.match(formatters, /metric === "followersNet" \|\| metric === "newFollowers"/);
  assert.match(formatters, /Math\.round\(Math\.abs\(value\)\)/);
  assert.match(formatters, /maximumFractionDigits: 0/);
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
  assert.match(styles, /\.audience-native-chart-heading strong\s*\{[\s\S]*?font-size:\s*clamp\(15px, 1\.35vw, 18px\)/);
  assert.match(styles, /\.audience-dashboard-toolbar\s*\{[\s\S]*?margin-bottom:\s*12px/);
  assert.match(styles, /\.audience-platform-grid\s*\{[\s\S]*?gap:\s*10px/);
  assert.match(styles, /\.audience-explorer\s*\{[\s\S]*?margin-top:\s*12px[\s\S]*?padding:\s*12px 14px/);
  assert.match(styles, /\.audience-native-chart-shell\s*\{[\s\S]*?margin-top:\s*8px/);
  assert.match(styles, /\.audience-demographics\s*\{[\s\S]*?margin-top:\s*14px[\s\S]*?padding:\s*14px 16px 16px/);
  assert.match(styles, /\.audience-demographic-card\s*\{[\s\S]*?min-height:\s*178px[\s\S]*?padding:\s*12px/);
  assert.match(styles, /\.audience-demographic-list li\s*\{[\s\S]*?min-height:\s*20px[\s\S]*?font-size:\s*clamp\(11px, 0\.78vw, 12px\)/);
  assert.match(styles, /\.audience-demographic-bar\s*\{[\s\S]*?height:\s*5px/);
  assert.match(component, /bottomReserve=\{300\}/);
});

test("syncs the clickable platform cards with an honest follower-change default", async () => {
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

  assert.match(dashboard, /useState<Platform>\("youtube"\)/);
  assert.match(dashboard, /const \[periodKey, setPeriodKey\] = useState<AudienceChartPeriodKey>\("30d"\)/);
  assert.match(dashboard, /aria-label="Période du tableau de bord"/);
  assert.match(dashboard, /selectAudiencePlatform/);
  assert.match(dashboard, /setRequestedMetric\(NATIVE_ANALYTICS_DEFAULT_METRIC\[platform\]\)/);
  assert.match(dashboard, /<button[\s\S]*?audience-platform-card/);
  assert.match(dashboard, /aria-controls="audience-explorer"/);
  assert.match(dashboard, /aria-pressed=\{platform === activePlatform\}/);
  assert.match(dashboard, /onClick=\{\(\) => selectAudiencePlatform\(platform\)\}/);
  assert.match(dashboard, /platform === "instagram" \? "Nouveaux followers" : "Variation followers"/);
  assert.match(dashboard, /platform === "instagram" \? null : growth\?\.followersDelta/);
  assert.match(dashboard, /audienceMetricEndDate\([\s\S]*?followerChangeMetric/);
  assert.match(dashboard, /nativeAnalyticsDailyForPeriod\([\s\S]*?followerChangeEndDate/);
  assert.match(dashboard, /calculatePlatformEngagementWindow\([\s\S]*?period\.days/);
  assert.match(dashboard, /followersDeltaPeriodLabel = nativeGrowth[\s\S]*?period\.label/);
  assert.match(dashboard, /activePlatform=\{activePlatform\}/);
  assert.match(dashboard, /onSelectPlatform=\{selectAudiencePlatform\}/);
  assert.match(dashboard, /periodKey=\{periodKey\}/);

  assert.match(component, /youtube:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /instagram:\s*\[\s*"newFollowers",\s*"followersTotal"/);
  assert.match(component, /tiktok:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /x:\s*\[\s*"followersNet",\s*"followersTotal"/);
  assert.match(component, /youtube:\s*"followersNet"/);
  assert.match(component, /instagram:\s*"newFollowers"/);
  assert.match(component, /tiktok:\s*"followersNet"/);
  assert.match(component, /x:\s*"followersNet"/);
  assert.match(explorer, /availableMetricWindows\.find\(\(window\) => window\.metric === requestedMetric\)/);
  assert.match(explorer, /onClick=\{\(\) => onSelectPlatform\(platform\)\}/);
  assert.doesNotMatch(explorer, /const \[chartPeriodKey|setChartPeriodKey|Période du graphique/);

  assert.match(styles, /\.audience-platform-card\.active\s*\{/);
  assert.match(styles, /\.audience-platform-card\.active::after\s*\{[\s\S]*?opacity:\s*1/);
  assert.match(styles, /\.audience-platform-card:focus-visible\s*\{/);
});

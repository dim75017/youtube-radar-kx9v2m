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
  assert.match(explorer, /aria-label="Plateforme du graphique"/);
  assert.match(explorer, /PLATFORM_ORDER\.map/);
  assert.match(explorer, /aria-pressed=\{platform === activePlatform\}/);
  assert.match(explorer, /aria-label=\{`Métrique du graphique/);
  assert.match(explorer, /availableMetrics\.map/);
  assert.match(explorer, /aria-pressed=\{metric === activeMetric\}/);
  assert.equal((component.match(/<AudienceNativeMetricChart\b/g) ?? []).length, 1);
  assert.doesNotMatch(component, /function AudienceGrowthChart/);
  assert.doesNotMatch(component, /function AudienceNativePlatformCard/);
  assert.doesNotMatch(component, /audience-native-platform-grid/);
  assert.doesNotMatch(component, /audience-evolution-block/);

  assert.match(explorer, /function audienceMetricSeries/);
  assert.match(explorer, /metric === "followersTotal"/);
  assert.match(explorer, /historyPoints/);
  assert.match(explorer, /point\.metrics\[metric\]/);
  assert.match(explorer, /byDate\.set\(date/);
  assert.match(explorer, /elapsedDays === 1 && comparablePrecision/);
  assert.match(explorer, /Données réelles · jours absents non reliés/);
  assert.doesNotMatch(explorer, /fillMissing|interpolate|interpolation linéaire/i);

  assert.match(styles, /\.audience-platform-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4/);
  assert.match(styles, /\.audience-explorer-platform-tabs/);
  assert.match(styles, /\.audience-explorer-metrics/);
  assert.match(styles, /\.audience-native-chart-viewport\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.audience-platform-grid/);
  assert.doesNotMatch(styles, /\.audience-chart-viewport|\.audience-native-platform-grid/);
});

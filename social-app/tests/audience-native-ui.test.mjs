import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders selectable native analytics without inventing missing daily values", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const nativeSection = component.slice(
    component.indexOf("type NativeAnalyticsMetricMeta"),
    component.indexOf("function AudienceGrowthChart"),
  );

  assert.match(component, /audienceAnalytics\?: AudienceAnalytics \| null/);
  assert.match(component, /analytics=\{audienceAnalytics\}/);
  assert.match(nativeSection, /Activité quotidienne par plateforme/);
  assert.match(nativeSection, /Total followers/);
  assert.match(nativeSection, /Variation nette des followers/);
  assert.match(nativeSection, /stock à une date donnée/);
  assert.match(nativeSection, /gains moins pertes/);
  assert.match(nativeSection, /audience-native-metric-grid/);
  assert.match(nativeSection, /aria-pressed=\{metric === activeMetric\}/);
  assert.match(nativeSection, /periodKey: AudiencePeriodKey/);
  assert.match(nativeSection, /periodDays: number \| null/);
  assert.match(nativeSection, /point\.metrics\[metric\]/);
  assert.match(nativeSection, /isNativeAnalyticsValue/);
  assert.match(nativeSection, /elapsedDays === 1/);
  assert.match(nativeSection, /Valeurs nulles ignorées · aucune interpolation/);
  assert.doesNotMatch(nativeSection, /fillMissing|interpolate|interpolation linéaire/i);

  assert.match(styles, /\.audience-native-metric-grid\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.audience-native-chart-viewport\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.audience-native-metric-grid/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?grid-template-columns:\s*1fr/);
});

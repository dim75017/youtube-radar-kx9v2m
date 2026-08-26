import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps follower values integral and lets the chart fill the remaining viewport", async () => {
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
  assert.match(chart, /window\.innerHeight - viewport\.getBoundingClientRect\(\)\.top - 38/);
  assert.match(chart, /Math\.max\(180, availableHeight\)/);
  assert.match(chart, /style=\{\{ height: `\$\{height\}px` \}\}/);

  assert.match(formatters, /metric === "followersTotal"/);
  assert.match(formatters, /metric === "followersNet"/);
  assert.match(formatters, /metric === "newFollowers"/);
  assert.match(formatters, /metric === "unfollows"/);
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
});

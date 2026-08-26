const GRANULAR_AGE_BUCKETS = [
  ["age_13_17", "13–17"],
  ["age_18_24", "18–24"],
  ["age_25_34", "25–34"],
  ["age_35_44", "35–44"],
  ["age_45_54", "45–54"],
  ["age_55_64", "55–64"],
  ["age_65_plus", "65+"],
];

const MERGED_AGE_BUCKETS = [
  ...GRANULAR_AGE_BUCKETS.slice(0, 5),
  ["age_55_plus", "55+"],
];

const GENDER_ORDER = new Map([
  ["female", 0],
  ["male", 1],
  ["user_specified", 2],
  ["other", 3],
]);

/**
 * @typedef {{ key: string, label: string, share: number, countryCode: string | null }} DemographicEntry
 * @typedef {{ key: string, label: string, share: number | null, countryCode: string | null, reported: boolean }} DemographicDisplayEntry
 */

/**
 * Keep every demographic card comparable without turning absent native data
 * into a fake zero. TikTok's native 55+ bucket remains merged.
 *
 * @param {DemographicEntry[]} entries
 * @param {"countries" | "ages" | "genders"} kind
 * @returns {DemographicDisplayEntry[]}
 */
export function audienceDemographicDisplayEntries(entries, kind) {
  if (kind === "countries") {
    return entries.map(reportedEntry);
  }

  if (kind === "genders") {
    return [...entries]
      .sort((left, right) => {
        const leftRank = GENDER_ORDER.get(left.key) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = GENDER_ORDER.get(right.key) ?? Number.MAX_SAFE_INTEGER;
        return leftRank - rightRank;
      })
      .map(reportedEntry);
  }

  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const usesMerged55Plus = entriesByKey.has("age_55_plus");
  const canonicalBuckets = usesMerged55Plus ? MERGED_AGE_BUCKETS : GRANULAR_AGE_BUCKETS;
  const canonicalKeys = new Set(canonicalBuckets.map(([key]) => key));
  const canonicalEntries = canonicalBuckets.map(([key, label]) => {
    const entry = entriesByKey.get(key);
    return entry
      ? { ...entry, label, reported: true }
      : { key, label, share: null, countryCode: null, reported: false };
  });
  const unknownEntries = entries
    .filter((entry) => !canonicalKeys.has(entry.key))
    .map(reportedEntry);
  return [...canonicalEntries, ...unknownEntries];
}

/** @param {DemographicEntry} entry */
function reportedEntry(entry) {
  return { ...entry, reported: true };
}

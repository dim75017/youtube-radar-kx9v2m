export const AUDIENCE_DEMOGRAPHICS_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
] as const;

export const AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS = [
  "countries",
  "ages",
  "genders",
] as const;

export const AUDIENCE_DEMOGRAPHICS_STATUSES = [
  "available",
  "partial",
  "unavailable",
] as const;

export type AudienceDemographicsPlatform =
  (typeof AUDIENCE_DEMOGRAPHICS_PLATFORMS)[number];
export type AudienceDemographicDimensionKey =
  (typeof AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS)[number];
export type AudienceDemographicsStatus =
  (typeof AUDIENCE_DEMOGRAPHICS_STATUSES)[number];

export type AudienceDemographicEntry = {
  key: string;
  label: string;
  share: number;
  countryCode: string | null;
};

export type AudienceDemographicProvenance = {
  provider: string;
  sourceUrl: string;
  collectedAt: string;
  basis: string;
  periodLabel: string;
};

export type AudienceDemographicDimension = {
  entries: AudienceDemographicEntry[];
  provenance: AudienceDemographicProvenance;
};

export type AudienceDemographicsPlatformSnapshot = {
  profileUrl: string;
  status: AudienceDemographicsStatus;
  countries: AudienceDemographicDimension | null;
  ages: AudienceDemographicDimension | null;
  genders: AudienceDemographicDimension | null;
};

export type AudienceDemographics = {
  version: 1;
  generatedAt: string;
  platforms: Record<
    AudienceDemographicsPlatform,
    AudienceDemographicsPlatformSnapshot
  >;
};

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO2_COUNTRY_PATTERN = /^[A-Z]{2}$/;
const DISTRIBUTION_TOLERANCE = 0.02;

/** Validate the complete, closed public contract for aggregate audience demographics. */
export function assertAudienceDemographics(
  value: unknown,
): AudienceDemographics {
  const snapshot = strictRecord(
    value,
    ["version", "generatedAt", "platforms"],
    "Le snapshot démographique audience",
  );
  if (snapshot.version !== 1) {
    throw new Error(
      "Le snapshot démographique audience doit utiliser la version 1.",
    );
  }

  const generatedAt = assertTimestamp(snapshot.generatedAt, "generatedAt");
  const generatedTime = Date.parse(generatedAt);
  const platforms = strictRecord(
    snapshot.platforms,
    AUDIENCE_DEMOGRAPHICS_PLATFORMS,
    "platforms",
  );

  for (const platform of AUDIENCE_DEMOGRAPHICS_PLATFORMS) {
    assertPlatform(platforms[platform], platform, generatedTime);
  }

  return value as AudienceDemographics;
}

function assertPlatform(
  value: unknown,
  platform: AudienceDemographicsPlatform,
  generatedTime: number,
): void {
  const snapshot = strictRecord(
    value,
    ["profileUrl", "status", ...AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS],
    platform,
  );
  assertHttpsUrl(snapshot.profileUrl, `${platform}.profileUrl`);

  if (
    typeof snapshot.status !== "string" ||
    !AUDIENCE_DEMOGRAPHICS_STATUSES.includes(
      snapshot.status as AudienceDemographicsStatus,
    )
  ) {
    throw new Error(`${platform}.status est inconnu.`);
  }

  let availableDimensionCount = 0;
  for (const dimensionKey of AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS) {
    const dimension = snapshot[dimensionKey];
    if (dimension === null) continue;
    availableDimensionCount += 1;
    assertDimension(dimension, platform, dimensionKey, generatedTime);
  }

  const expectedStatus: AudienceDemographicsStatus =
    availableDimensionCount === 0
      ? "unavailable"
      : availableDimensionCount === AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS.length
        ? "available"
        : "partial";
  if (snapshot.status !== expectedStatus) {
    throw new Error(
      `${platform}.status doit être ${expectedStatus} pour les dimensions fournies.`,
    );
  }
}

function assertDimension(
  value: unknown,
  platform: AudienceDemographicsPlatform,
  dimensionKey: AudienceDemographicDimensionKey,
  generatedTime: number,
): void {
  const label = `${platform}.${dimensionKey}`;
  const dimension = strictRecord(value, ["entries", "provenance"], label);
  if (!Array.isArray(dimension.entries) || dimension.entries.length === 0) {
    throw new Error(`${label}.entries doit être un tableau non vide.`);
  }

  const keys = new Set<string>();
  const countryCodes = new Set<string>();
  let totalShare = 0;
  for (const [index, value] of dimension.entries.entries()) {
    const entryLabel = `${label}.entries[${index}]`;
    const entry = strictRecord(
      value,
      ["key", "label", "share", "countryCode"],
      entryLabel,
    );
    const key = assertNonemptyString(entry.key, `${entryLabel}.key`);
    assertNonemptyString(entry.label, `${entryLabel}.label`);
    if (keys.has(key)) {
      throw new Error(`${label}.entries contient la clé dupliquée ${key}.`);
    }
    keys.add(key);

    if (
      typeof entry.share !== "number" ||
      !Number.isFinite(entry.share) ||
      entry.share < 0 ||
      entry.share > 1
    ) {
      throw new Error(`${entryLabel}.share doit être compris entre 0 et 1.`);
    }
    totalShare += entry.share;

    if (dimensionKey === "countries") {
      if (key === "other_territories") {
        if (entry.countryCode !== null) {
          throw new Error(`${entryLabel}.countryCode doit être null pour Autres.`);
        }
      } else {
        if (
          typeof entry.countryCode !== "string" ||
          !ISO2_COUNTRY_PATTERN.test(entry.countryCode)
        ) {
          throw new Error(`${entryLabel}.countryCode doit être un code ISO2.`);
        }
        if (countryCodes.has(entry.countryCode)) {
          throw new Error(
            `${label}.entries contient le code pays dupliqué ${entry.countryCode}.`,
          );
        }
        countryCodes.add(entry.countryCode);
      }
    } else if (entry.countryCode !== null) {
      throw new Error(`${entryLabel}.countryCode doit être null hors pays.`);
    }
  }

  if (dimensionKey === "countries") {
    if (totalShare > 1 + DISTRIBUTION_TOLERANCE) {
      throw new Error(`${label} dépasse 100 % après tolérance d’arrondi.`);
    }
  } else if (Math.abs(totalShare - 1) > DISTRIBUTION_TOLERANCE) {
    throw new Error(`${label} doit totaliser environ 100 %.`);
  }

  assertProvenance(dimension.provenance, `${label}.provenance`, generatedTime);
}

function assertProvenance(
  value: unknown,
  label: string,
  generatedTime: number,
): void {
  const provenance = strictRecord(
    value,
    ["provider", "sourceUrl", "collectedAt", "basis", "periodLabel"],
    label,
  );
  assertNonemptyString(provenance.provider, `${label}.provider`);
  assertHttpsUrl(provenance.sourceUrl, `${label}.sourceUrl`);
  const collectedAt = assertTimestamp(
    provenance.collectedAt,
    `${label}.collectedAt`,
  );
  if (Date.parse(collectedAt) > generatedTime) {
    throw new Error(`${label}.collectedAt ne peut pas être postérieur à generatedAt.`);
  }
  assertNonemptyString(provenance.basis, `${label}.basis`);
  assertNonemptyString(provenance.periodLabel, `${label}.periodLabel`);
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} manque les clés : ${missing.join(", ")}.`);
  }
  if (unknown.length > 0) {
    throw new Error(`${label} contient des clés inconnues : ${unknown.join(", ")}.`);
  }
  return record;
}

function assertTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} doit être un timestamp ISO avec fuseau horaire.`);
  }
  return value;
}

function assertHttpsUrl(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
}

function assertNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} est requis.`);
  }
  return value;
}

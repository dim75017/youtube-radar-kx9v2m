/**
 * JSON.parse accepts lone UTF-16 surrogates, but JavaScript/Vite JSON loaders
 * may reject the corresponding `\udxxx` escape. Keep every persisted string
 * well-formed while preserving every valid Unicode code point unchanged.
 */
export function toWellFormedUnicode(value) {
  const input = String(value ?? "");
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\ufffd";
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      output += "\ufffd";
    } else {
      output += input[index];
    }
  }

  return output;
}

export function truncateUnicode(value, maximumCodePoints) {
  if (!Number.isSafeInteger(maximumCodePoints) || maximumCodePoints < 0) {
    throw new TypeError("maximumCodePoints must be a non-negative safe integer");
  }
  return Array.from(toWellFormedUnicode(value)).slice(0, maximumCodePoints).join("");
}

export function sanitizeJsonUnicode(value) {
  if (typeof value === "string") return toWellFormedUnicode(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonUnicode);
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = toWellFormedUnicode(rawKey);
    if (Object.hasOwn(sanitized, key) && key !== rawKey) {
      throw new Error(`Unicode normalization would merge two JSON keys into ${JSON.stringify(key)}.`);
    }
    sanitized[key] = sanitizeJsonUnicode(rawValue);
  }
  return sanitized;
}

export function hasUnpairedSurrogate(value) {
  if (typeof value === "string") return value !== toWellFormedUnicode(value);
  if (Array.isArray(value)) return value.some(hasUnpairedSurrogate);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    key !== toWellFormedUnicode(key) || hasUnpairedSurrogate(nested)
  ));
}

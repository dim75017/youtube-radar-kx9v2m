import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUnpairedSurrogate,
  sanitizeJsonUnicode,
  toWellFormedUnicode,
  truncateUnicode,
} from "../scripts/lib/well_formed_unicode.mjs";

test("code-point truncation never splits an emoji surrogate pair", () => {
  const title = truncateUnicode(`${"a".repeat(179)}\ud83c\udf38tail`, 180);

  assert.equal(Array.from(title).length, 180);
  assert.equal(title.endsWith("\ud83c\udf38"), true);
  assert.equal(hasUnpairedSurrogate(title), false);
});

test("valid Unicode remains byte-for-byte identical", () => {
  const value = "Lofi \ud83c\udf38 \ud83d\udc69\u200d\ud83c\udfa8 cafe\u0301";
  assert.equal(toWellFormedUnicode(value), value);
});

test("lone surrogates are replaced recursively without changing JSON shape", () => {
  const source = {
    posts: [
      { id: "1", title: `broken-high-\ud83c`, likes: 42 },
      { id: "2", title: `broken-low-\udf38`, likes: 7 },
    ],
  };

  const sanitized = sanitizeJsonUnicode(source);
  assert.equal(hasUnpairedSurrogate(sanitized), false);
  assert.equal(sanitized.posts.length, 2);
  assert.deepEqual(sanitized.posts.map((post) => post.likes), [42, 7]);
  assert.equal(sanitized.posts[0].title, "broken-high-\ufffd");
  assert.equal(sanitized.posts[1].title, "broken-low-\ufffd");
});

import assert from "node:assert/strict";
import test from "node:test";

import { ensureTextElementBounds } from "../build/elements.js";

test("repairs zero-sized text using its font metrics", () => {
  const element = ensureTextElementBounds({
    type: "text",
    text: "Hello",
    fontSize: 20,
    lineHeight: 1.25,
    width: 0,
    height: 0,
  });

  assert.deepEqual(
    { width: element.width, height: element.height },
    { width: 60, height: 25 },
  );
});

test("repairs missing bounds and supports multiline text", () => {
  const element = ensureTextElementBounds({
    type: "text",
    text: "Short\nLonger",
    fontSize: 10,
    lineHeight: 2,
  });

  assert.deepEqual(
    { width: element.width, height: element.height },
    { width: 36, height: 40 },
  );
});

test("preserves valid text bounds and non-text elements", () => {
  const text = { type: "text", text: "Keep me", width: 123, height: 45 };
  const rectangle = { type: "rectangle", width: 0, height: 0 };

  assert.equal(ensureTextElementBounds(text), text);
  assert.equal(ensureTextElementBounds(rectangle), rectangle);
});

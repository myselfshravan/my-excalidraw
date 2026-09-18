import assert from "node:assert/strict";
import test from "node:test";

import {
  arrangeElements,
  describeElement,
  findElements,
  recenterBoundLabels,
  reorderElements,
} from "../build/query.js";
import {
  createArrow,
  createBoundLabel,
  createRectangle,
} from "../build/elements.js";

const box = (x, y, w = 100, h = 50, extra = {}) => ({
  ...createRectangle({ x, y, width: w, height: h }),
  ...extra,
});

test("finds by type, text and id", () => {
  const els = [
    box(0, 0),
    { ...box(0, 0), type: "text", text: "Auth service" },
    { ...box(0, 0), type: "text", text: "Billing" },
  ];
  assert.equal(findElements(els, { type: ["text"] }).length, 2);
  assert.equal(findElements(els, { text: "auth" }).length, 1);
  assert.equal(findElements(els, { ids: [els[0].id] })[0].id, els[0].id);
});

test("region matches intersection, not containment", () => {
  const els = [box(0, 0, 100, 100), box(500, 500, 100, 100)];
  const hit = findElements(els, {
    region: { x: 50, y: 50, width: 10, height: 10 },
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, els[0].id);
});

test("deleted elements are excluded unless asked for", () => {
  const els = [box(0, 0), { ...box(0, 0), isDeleted: true }];
  assert.equal(findElements(els, {}).length, 1);
  assert.equal(findElements(els, { include_deleted: true }).length, 2);
});

test("describe reports arrows in and out with their far-end text", () => {
  const a = box(0, 0);
  const b = box(300, 0);
  const aLabel = createBoundLabel(a, "Start");
  const bLabel = createBoundLabel(b, "Finish");
  const arrow = createArrow(
    { from: { elementId: a.id }, to: { elementId: b.id } },
    [a, b],
  );
  const els = [a, aLabel, b, bLabel, arrow];

  const outFromA = describeElement(els, a.id).relationships;
  assert.equal(outFromA.outgoingArrows.length, 1);
  assert.equal(outFromA.outgoingArrows[0].toLabel, "Finish");
  assert.equal(outFromA.label.text, "Start");

  const intoB = describeElement(els, b.id).relationships;
  assert.equal(intoB.incomingArrows.length, 1);
  assert.equal(intoB.incomingArrows[0].fromLabel, "Start");
});

test("a bound label knows its container", () => {
  const shape = box(0, 0);
  const lbl = createBoundLabel(shape, "Inside");
  assert.equal(lbl.containerId, shape.id);
  assert.deepEqual(shape.boundElements, [{ id: lbl.id, type: "text" }]);
  assert.equal(lbl.textAlign, "center");
  assert.equal(lbl.verticalAlign, "middle");
});

test("align-left puts every element on the leftmost edge", () => {
  const els = [box(10, 0), box(90, 60), box(50, 120)];
  arrangeElements(els, "align-left");
  assert.deepEqual(els.map((e) => e.x), [10, 10, 10]);
});

test("align-right accounts for differing widths", () => {
  const els = [box(0, 0, 100), box(0, 60, 40)];
  arrangeElements(els, "align-right");
  // Right edge is 100; the narrow box starts at 60.
  assert.deepEqual(els.map((e) => e.x), [0, 60]);
});

test("stack-vertical lays elements out with a fixed gap", () => {
  const els = [box(0, 0, 100, 50), box(0, 500, 100, 50), box(0, 900, 100, 50)];
  arrangeElements(els, "stack-vertical", { gap: 10 });
  assert.deepEqual(els.map((e) => e.y), [0, 60, 120]);
});

test("distribute-horizontal evens the gaps and keeps the ends fixed", () => {
  const els = [box(0, 0, 100), box(150, 0, 100), box(400, 0, 100)];
  arrangeElements(els, "distribute-horizontal");
  const xs = els.map((e) => e.x);
  assert.equal(xs[0], 0);
  assert.equal(xs[2], 400);
  // Equal spacing: 500 span - 300 total width = 200 over 2 gaps.
  assert.equal(xs[1], 200);
});

test("distribute needs three elements to mean anything", () => {
  const els = [box(0, 0), box(100, 0)];
  assert.equal(arrangeElements(els, "distribute-horizontal"), 0);
});

test("grid lays out by columns", () => {
  const els = [box(0, 0, 100, 50), box(0, 0, 100, 50), box(0, 0, 100, 50)];
  arrangeElements(els, "grid", { columns: 2, gap: 10 });
  assert.deepEqual(
    els.map((e) => [e.x, e.y]),
    [
      [0, 0],
      [110, 0],
      [0, 60],
    ],
  );
});

test("z-order: front and back move elements to the ends", () => {
  const [a, b, c] = [box(0, 0), box(0, 0), box(0, 0)];
  assert.deepEqual(
    reorderElements([a, b, c], [a.id], "front").map((e) => e.id),
    [b.id, c.id, a.id],
  );
  assert.deepEqual(
    reorderElements([a, b, c], [c.id], "back").map((e) => e.id),
    [c.id, a.id, b.id],
  );
});

test("z-order: forward swaps with the next element only", () => {
  const [a, b, c] = [box(0, 0), box(0, 0), box(0, 0)];
  assert.deepEqual(
    reorderElements([a, b, c], [a.id], "forward").map((e) => e.id),
    [b.id, a.id, c.id],
  );
});

test("z-order: moving several forward keeps their relative order", () => {
  const [a, b, c, d] = [box(0, 0), box(0, 0), box(0, 0), box(0, 0)];
  const out = reorderElements([a, b, c, d], [a.id, b.id], "forward");
  assert.deepEqual(out.map((e) => e.id), [c.id, a.id, b.id, d.id]);
});

test("a bound label follows its container when the container moves", () => {
  const shape = box(0, 0, 200, 100);
  const lbl = createBoundLabel(shape, "Caption");
  const els = [shape, lbl];
  const startX = lbl.x;

  arrangeElements([shape], "stack-vertical");
  shape.x += 300;
  shape.y += 50;
  const moved = recenterBoundLabels(els, new Set([shape.id]));

  assert.deepEqual(moved, [lbl.id]);
  assert.equal(lbl.x, startX + 300);
  // Still centred within the container.
  assert.equal(lbl.x + lbl.width / 2, shape.x + shape.width / 2);
  assert.equal(lbl.y + lbl.height / 2, shape.y + shape.height / 2);
});

test("re-centring ignores containers that did not change", () => {
  const shape = box(0, 0, 200, 100);
  const lbl = createBoundLabel(shape, "Caption");
  assert.deepEqual(recenterBoundLabels([shape, lbl], new Set()), []);
});

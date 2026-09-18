import assert from "node:assert/strict";
import test from "node:test";

import {
  attachArrowBindings,
  createArrow,
  createLine,
  createRectangle,
  reanchorArrow,
} from "../build/elements.js";

test("line points are rebased onto the element origin", () => {
  const line = createLine({
    points: [
      [100, 200],
      [150, 260],
      [90, 240],
    ],
  });

  // Origin is the first point; points are stored relative to it with
  // points[0] pinned at [0, 0].
  assert.deepEqual({ x: line.x, y: line.y }, { x: 100, y: 200 });
  assert.deepEqual(line.points, [
    [0, 0],
    [50, 60],
    [-10, 40],
  ]);
  // Bounding box spans the relative extent, not the absolute coordinates.
  assert.deepEqual(
    { width: line.width, height: line.height },
    { width: 60, height: 60 },
  );
});

test("explicit x/y overrides the origin without moving the points", () => {
  const line = createLine({
    x: 0,
    y: 0,
    points: [
      [10, 10],
      [20, 30],
    ],
  });

  assert.deepEqual({ x: line.x, y: line.y }, { x: 0, y: 0 });
  assert.deepEqual(line.points, [
    [0, 0],
    [10, 20],
  ]);
});

test("elements carry a creation timestamp", () => {
  const rect = createRectangle({ x: 0, y: 0, width: 10, height: 10 });
  assert.equal(typeof rect.created, "number");
  assert.ok(rect.created > 0);
});

test("bound arrow starts and ends on the shape edges, not the centres", () => {
  const a = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const b = createRectangle({ x: 300, y: 0, width: 100, height: 100 });
  const shapes = [a, b];

  const arrow = createArrow(
    { from: { elementId: a.id }, to: { elementId: b.id } },
    shapes,
  );

  // Centres are (50,50) and (350,50); the ray is horizontal, so each end sits
  // on the facing vertical edge plus the 8px binding gap.
  assert.deepEqual({ x: arrow.x, y: arrow.y }, { x: 108, y: 50 });
  assert.deepEqual(arrow.points, [
    [0, 0],
    [184, 0],
  ]);
  assert.equal(arrow.startBinding.elementId, a.id);
  assert.equal(arrow.endBinding.elementId, b.id);
  assert.equal(arrow.startBinding.gap, 8);
});

test("ellipse endpoints use the ellipse boundary", () => {
  const circle = createArrow(
    { from: { elementId: "c" }, to: { x: 500, y: 50 } },
    [{ id: "c", type: "ellipse", x: 0, y: 0, width: 100, height: 100 }],
  );

  // Horizontal ray out of a circle of radius 50 centred at (50,50): 50 + 8 gap.
  assert.deepEqual({ x: circle.x, y: circle.y }, { x: 108, y: 50 });
});

test("diamond endpoints use the diamond boundary", () => {
  const arrow = createArrow(
    { from: { elementId: "d" }, to: { x: 500, y: 50 } },
    [{ id: "d", type: "diamond", x: 0, y: 0, width: 100, height: 100 }],
  );

  // A horizontal ray leaves a diamond at its vertex: half-width 50, + 8 gap.
  assert.deepEqual({ x: arrow.x, y: arrow.y }, { x: 108, y: 50 });
});

test("endpoints never overshoot a target closer than the binding gap", () => {
  const a = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const b = createRectangle({ x: 101, y: 0, width: 100, height: 100 });

  const arrow = createArrow(
    { from: { elementId: a.id }, to: { elementId: b.id } },
    [a, b],
  );

  // Centres are 101 apart; the anchor is clamped to the other centre rather
  // than being pushed past it by the gap.
  assert.ok(arrow.x <= 151, `start ${arrow.x} should not pass the far centre`);
});

test("a coordinate endpoint produces no binding", () => {
  const arrow = createArrow({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
  assert.equal(arrow.startBinding, null);
  assert.equal(arrow.endBinding, null);
});

test("a binding to a missing element is dropped rather than dangling", () => {
  const arrow = createArrow(
    { from: { elementId: "nope" }, to: { x: 10, y: 10 } },
    [],
  );
  assert.equal(arrow.startBinding, null);
});

test("bindings are recorded on the shapes too", () => {
  const a = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const b = createRectangle({ x: 300, y: 0, width: 100, height: 100 });
  const shapes = [a, b];
  const arrow = createArrow(
    { from: { elementId: a.id }, to: { elementId: b.id } },
    shapes,
  );

  attachArrowBindings(arrow, shapes);

  assert.deepEqual(a.boundElements, [{ id: arrow.id, type: "arrow" }]);
  assert.deepEqual(b.boundElements, [{ id: arrow.id, type: "arrow" }]);

  // Idempotent: re-attaching must not duplicate the entry.
  attachArrowBindings(arrow, shapes);
  assert.equal(a.boundElements.length, 1);
});

test("attaching preserves existing boundElements entries", () => {
  const shape = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  shape.boundElements = [{ id: "existing-text", type: "text" }];
  const arrow = createArrow(
    { from: { elementId: shape.id }, to: { x: 500, y: 50 } },
    [shape],
  );

  attachArrowBindings(arrow, [shape]);

  assert.deepEqual(shape.boundElements, [
    { id: "existing-text", type: "text" },
    { id: arrow.id, type: "arrow" },
  ]);
});

test("re-anchors a bound arrow after its shape moves", () => {
  const a = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const b = createRectangle({ x: 300, y: 0, width: 100, height: 100 });
  const shapes = [a, b];
  const arrow = createArrow(
    { from: { elementId: a.id }, to: { elementId: b.id } },
    shapes,
  );

  assert.equal(arrow.x, 108);

  // Move `a` right by 40; the arrow must start from its new edge.
  a.x += 40;
  assert.equal(reanchorArrow(arrow, [...shapes, arrow]), true);

  assert.deepEqual({ x: arrow.x, y: arrow.y }, { x: 148, y: 50 });
  assert.deepEqual(arrow.points, [
    [0, 0],
    [144, 0],
  ]);
  assert.equal(arrow.width, 144);
});

test("a free end keeps its absolute position when re-anchoring", () => {
  const shape = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const arrow = createArrow(
    { from: { elementId: shape.id }, to: { x: 400, y: 50 } },
    [shape],
  );

  shape.y += 100;
  reanchorArrow(arrow, [shape, arrow]);

  // The unbound end is still exactly where it was asked to be.
  const endX = arrow.x + arrow.points[1][0];
  const endY = arrow.y + arrow.points[1][1];
  assert.deepEqual({ x: Math.round(endX), y: Math.round(endY) }, { x: 400, y: 50 });
});

test("re-anchoring leaves unbound and multi-point arrows alone", () => {
  const loose = createArrow({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
  assert.equal(reanchorArrow(loose, []), false);

  const shape = createRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const multi = createArrow(
    { from: { elementId: shape.id }, to: { x: 400, y: 50 } },
    [shape],
  );
  multi.points = [
    [0, 0],
    [50, 80],
    [200, 0],
  ];
  assert.equal(reanchorArrow(multi, [shape]), false);
  assert.equal(multi.points.length, 3);
});

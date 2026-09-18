// Factories for Excalidraw element objects with all required fields populated.
// Element shape mirrors packages/element/types.ts in the app; we keep this in
// sync manually rather than importing from there since the app package is a
// browser ESM bundle.

import { randomBytes, randomUUID } from "node:crypto";

type RGBAColor = string;

export type BaseElementOptions = {
  strokeColor?: RGBAColor;
  backgroundColor?: RGBAColor;
  fillStyle?: "hachure" | "cross-hatch" | "solid" | "zigzag";
  strokeWidth?: 1 | 2 | 4;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: 0 | 1 | 2;
  opacity?: number;
  angle?: number;
  groupIds?: string[];
  link?: string | null;
};

const newId = () => randomUUID();
const seed = () => randomBytes(4).readUInt32BE(0);
const nonce = () => randomBytes(4).readUInt32BE(0);

const baseDefaults = (opts: BaseElementOptions = {}) => ({
  id: newId(),
  angle: opts.angle ?? 0,
  strokeColor: opts.strokeColor ?? "#1e1e1e",
  backgroundColor: opts.backgroundColor ?? "transparent",
  fillStyle: opts.fillStyle ?? "solid",
  strokeWidth: opts.strokeWidth ?? 2,
  strokeStyle: opts.strokeStyle ?? "solid",
  roughness: opts.roughness ?? 1,
  opacity: opts.opacity ?? 100,
  groupIds: opts.groupIds ?? [],
  frameId: null as string | null,
  index: null as string | null,
  roundness: null as { type: number; value?: number } | null,
  seed: seed(),
  version: 1,
  versionNonce: nonce(),
  isDeleted: false,
  boundElements: null as { id: string; type: "arrow" | "text" }[] | null,
  updated: Date.now(),
  created: Date.now(),
  link: opts.link ?? null,
  locked: false,
});

export type ShapeArgs = {
  x: number;
  y: number;
  width: number;
  height: number;
} & BaseElementOptions;

export const createRectangle = (args: ShapeArgs) => ({
  type: "rectangle" as const,
  ...baseDefaults(args),
  x: args.x,
  y: args.y,
  width: args.width,
  height: args.height,
  roundness: { type: 3 },
});

export const createEllipse = (args: ShapeArgs) => ({
  type: "ellipse" as const,
  ...baseDefaults(args),
  x: args.x,
  y: args.y,
  width: args.width,
  height: args.height,
});

export const createDiamond = (args: ShapeArgs) => ({
  type: "diamond" as const,
  ...baseDefaults(args),
  x: args.x,
  y: args.y,
  width: args.width,
  height: args.height,
});

export type TextArgs = {
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  fontFamily?: 1 | 2 | 3; // 1=Hand-drawn, 2=Normal, 3=Code
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
} & BaseElementOptions;

// Rough text width heuristic so the element has a plausible bounding box.
// The app may re-measure it more precisely when the text is edited.
const estimateTextSize = (
  text: string,
  fontSize: number,
  lineHeight = 1.25,
) => {
  const lines = text.split("\n");
  const longest = lines.reduce((acc, l) => Math.max(acc, l.length), 0);
  return {
    width: Math.max(20, Math.ceil(longest * fontSize * 0.6)),
    height: Math.max(
      fontSize * lineHeight,
      lines.length * fontSize * lineHeight,
    ),
  };
};

type ElementLike = Record<string, unknown>;

const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Gives imported text elements usable bounds when callers omit them or pass
 * invalid values. Valid bounds are preserved so `replace_workspace` remains a
 * lossless replacement for correctly formed Excalidraw scenes.
 */
export const ensureTextElementBounds = <T extends ElementLike>(
  element: T,
): T => {
  if (
    element.type !== "text" ||
    (isPositiveFiniteNumber(element.width) &&
      isPositiveFiniteNumber(element.height))
  ) {
    return element;
  }

  const text = typeof element.text === "string" ? element.text : "";
  const fontSize = isPositiveFiniteNumber(element.fontSize)
    ? element.fontSize
    : 20;
  const lineHeight = isPositiveFiniteNumber(element.lineHeight)
    ? element.lineHeight
    : 1.25;
  const { width, height } = estimateTextSize(text, fontSize, lineHeight);

  return { ...element, width, height };
};

export const createText = (args: TextArgs) => {
  const fontSize = args.fontSize ?? 20;
  const lineHeight = 1.25;
  const { width, height } = estimateTextSize(args.text, fontSize, lineHeight);
  return {
    type: "text" as const,
    ...baseDefaults(args),
    x: args.x,
    y: args.y,
    width,
    height,
    text: args.text,
    fontSize,
    fontFamily: args.fontFamily ?? 1,
    textAlign: args.textAlign ?? "left",
    verticalAlign: args.verticalAlign ?? "top",
    containerId: null,
    originalText: args.text,
    autoResize: true,
    lineHeight,
  };
};

export type ArrowEnd = { x: number; y: number } | { elementId: string };

export type ArrowArgs = {
  from: ArrowEnd;
  to: ArrowEnd;
  startArrowhead?: "arrow" | "bar" | "dot" | "triangle" | null;
  endArrowhead?: "arrow" | "bar" | "dot" | "triangle" | null;
} & BaseElementOptions;

const isCoord = (e: ArrowEnd): e is { x: number; y: number } => "x" in e;

export type BindableElement = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  boundElements?: { id: string; type: "arrow" | "text" }[] | null;
};

const BINDING_GAP = 8;

const centerOf = (el: BindableElement) => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
});

/**
 * Point where the ray from `el`'s centre toward `toward` leaves the shape,
 * pushed out by BINDING_GAP. Anchoring here rather than at the centre keeps a
 * bound arrow outside the shapes it connects instead of running through them.
 *
 * `t` is the centre-to-boundary distance along the unit direction, solved per
 * shape: an ellipse from (x/a)^2+(y/b)^2=1, a diamond from |x|/a+|y|/b=1, and a
 * rectangle from whichever of the two axis-aligned edges the ray reaches first.
 */
const anchorOnShape = (
  el: BindableElement,
  toward: { x: number; y: number },
): { x: number; y: number } => {
  const center = centerOf(el);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return center;
  }
  const ux = dx / len;
  const uy = dy / len;
  const a = Math.abs(el.width) / 2;
  const b = Math.abs(el.height) / 2;
  if (a === 0 || b === 0) {
    return center;
  }

  let t: number;
  switch (el.type) {
    case "ellipse":
      t = 1 / Math.hypot(ux / a, uy / b);
      break;
    case "diamond":
      t = 1 / (Math.abs(ux) / a + Math.abs(uy) / b);
      break;
    default:
      t = Math.min(
        ux === 0 ? Infinity : a / Math.abs(ux),
        uy === 0 ? Infinity : b / Math.abs(uy),
      );
  }

  // Never overshoot the target when shapes are closer together than the gap.
  const reach = Math.min(t + BINDING_GAP, len);
  return { x: center.x + ux * reach, y: center.y + uy * reach };
};

/**
 * Recomputes a bound arrow's endpoints from its bindings' CURRENT geometry, so
 * an arrow still meets the shapes' edges after one of them is moved or resized.
 * Excalidraw only re-routes bindings during interactive drags; a scene loaded
 * from JSON keeps whatever points were stored, so a programmatic move has to do
 * this itself or the arrow ends up detached from (or buried inside) the shape.
 *
 * A free end keeps its absolute position. Returns false if there was nothing to
 * re-anchor, or if the arrow has intermediate points — reducing a multi-point
 * arrow to a straight line would discard the shape the user drew.
 */
export const reanchorArrow = (
  arrow: {
    x: number;
    y: number;
    width: number;
    height: number;
    points: number[][];
    startBinding: { elementId: string } | null;
    endBinding: { elementId: string } | null;
  },
  elements: BindableElement[],
): boolean => {
  if (arrow.points.length !== 2) {
    return false;
  }
  const find = (id?: string) =>
    id ? elements.find((e) => e.id === id) ?? null : null;
  const startEl = find(arrow.startBinding?.elementId);
  const endEl = find(arrow.endBinding?.elementId);
  if (!startEl && !endEl) {
    return false;
  }

  const [first, last] = arrow.points;
  const absStart = { x: arrow.x + first[0], y: arrow.y + first[1] };
  const absEnd = { x: arrow.x + last[0], y: arrow.y + last[1] };

  // Aim each bound end at the other end's centre (or its fixed free point).
  const newStart = startEl
    ? anchorOnShape(startEl, endEl ? centerOf(endEl) : absEnd)
    : absStart;
  const newEnd = endEl
    ? anchorOnShape(endEl, startEl ? centerOf(startEl) : absStart)
    : absEnd;

  arrow.x = newStart.x;
  arrow.y = newStart.y;
  arrow.points = [
    [0, 0],
    [newEnd.x - newStart.x, newEnd.y - newStart.y],
  ];
  arrow.width = Math.abs(newEnd.x - newStart.x);
  arrow.height = Math.abs(newEnd.y - newStart.y);
  return true;
};

/**
 * Records the arrow on each shape it binds to. Excalidraw's bindings are
 * two-way: the arrow names the shape via start/endBinding, and the shape must
 * name the arrow in `boundElements`, or dragging the shape leaves the arrow
 * behind. Mutates the elements in `scene`.
 */
export const attachArrowBindings = (
  arrow: {
    id: string;
    startBinding: { elementId: string } | null;
    endBinding: { elementId: string } | null;
  },
  elements: BindableElement[],
): void => {
  const boundIds = new Set(
    [arrow.startBinding?.elementId, arrow.endBinding?.elementId].filter(
      (id): id is string => !!id,
    ),
  );
  for (const el of elements) {
    if (!boundIds.has(el.id)) {
      continue;
    }
    const bound = el.boundElements ?? [];
    if (!bound.some((b) => b.id === arrow.id)) {
      el.boundElements = [...bound, { id: arrow.id, type: "arrow" }];
    }
  }
};

export const createArrow = (
  args: ArrowArgs,
  existingElements: BindableElement[] = [],
) => {
  const resolve = (
    end: ArrowEnd,
    fallback: { x: number; y: number },
  ): { el: BindableElement | null; point: { x: number; y: number } } => {
    if (isCoord(end)) {
      return { el: null, point: end };
    }
    const el = existingElements.find((e) => e.id === end.elementId) ?? null;
    return { el, point: el ? centerOf(el) : fallback };
  };

  // Resolve against centres first, then walk each bound end out to its shape's
  // edge along the centre-to-centre line.
  const from = resolve(args.from, { x: 0, y: 0 });
  const to = resolve(args.to, { x: 100, y: 0 });

  const startPoint = from.el ? anchorOnShape(from.el, to.point) : from.point;
  const endPoint = to.el ? anchorOnShape(to.el, from.point) : to.point;

  const width = endPoint.x - startPoint.x;
  const height = endPoint.y - startPoint.y;

  // A bound end only gets a binding record if its element actually exists —
  // otherwise the arrow would reference a missing id and the app would drop it.
  const startBinding = from.el
    ? { elementId: from.el.id, focus: 0, gap: BINDING_GAP }
    : null;
  const endBinding = to.el
    ? { elementId: to.el.id, focus: 0, gap: BINDING_GAP }
    : null;

  return {
    type: "arrow" as const,
    ...baseDefaults(args),
    x: startPoint.x,
    y: startPoint.y,
    width: Math.abs(width),
    height: Math.abs(height),
    points: [
      [0, 0],
      [width, height],
    ] as [number, number][],
    lastCommittedPoint: null,
    startBinding,
    endBinding,
    startArrowhead: args.startArrowhead ?? null,
    endArrowhead: args.endArrowhead ?? "arrow",
    elbowed: false,
  };
};

export type LineArgs = {
  points: number[][];
  x?: number;
  y?: number;
} & BaseElementOptions;

export const createLine = (args: LineArgs) => {
  // Excalidraw stores linear-element points RELATIVE to the element's x/y, with
  // points[0] pinned at [0, 0]. Callers pass absolute canvas coordinates, so
  // the first point becomes the origin and the rest are rebased onto it —
  // otherwise every point past the first renders at double its offset.
  const [originX, originY] = args.points[0];
  const points = args.points.map(
    (p) => [p[0] - originX, p[1] - originY] as [number, number],
  );
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    type: "line" as const,
    ...baseDefaults(args),
    x: args.x ?? originX,
    y: args.y ?? originY,
    width,
    height,
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
};

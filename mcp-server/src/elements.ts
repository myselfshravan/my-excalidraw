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
    height: Math.max(fontSize * lineHeight, lines.length * fontSize * lineHeight),
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
export const ensureTextElementBounds = <T extends ElementLike>(element: T): T => {
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

const bindingForElement = (
  existing: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  id: string,
): { elementId: string; focus: number; gap: number; center: { x: number; y: number } } | null => {
  const el = existing.find((e) => e.id === id);
  if (!el) {
    return null;
  }
  return {
    elementId: id,
    focus: 0,
    gap: 8,
    center: { x: el.x + el.width / 2, y: el.y + el.height / 2 },
  };
};

export const createArrow = (
  args: ArrowArgs,
  existingElements: Array<{ id: string; x: number; y: number; width: number; height: number }> = [],
) => {
  const startPoint = isCoord(args.from)
    ? args.from
    : (() => {
        const b = bindingForElement(existingElements, args.from.elementId);
        return b ? b.center : { x: 0, y: 0 };
      })();
  const endPoint = isCoord(args.to)
    ? args.to
    : (() => {
        const b = bindingForElement(existingElements, args.to.elementId);
        return b ? b.center : { x: 100, y: 0 };
      })();

  const x = startPoint.x;
  const y = startPoint.y;
  const width = endPoint.x - startPoint.x;
  const height = endPoint.y - startPoint.y;

  return {
    type: "arrow" as const,
    ...baseDefaults(args),
    x,
    y,
    width,
    height,
    points: [
      [0, 0],
      [width, height],
    ] as [number, number][],
    lastCommittedPoint: null,
    startBinding: isCoord(args.from)
      ? null
      : { elementId: args.from.elementId, focus: 0, gap: 8 },
    endBinding: isCoord(args.to)
      ? null
      : { elementId: args.to.elementId, focus: 0, gap: 8 },
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
  const xs = args.points.map((p) => p[0]);
  const ys = args.points.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    type: "line" as const,
    ...baseDefaults(args),
    x: args.x ?? Math.min(...xs),
    y: args.y ?? Math.min(...ys),
    width,
    height,
    points: args.points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
};

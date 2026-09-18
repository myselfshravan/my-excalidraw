// Scene navigation and layout helpers. These operate on plain scene elements
// so they stay testable without Firebase.

export type El = Record<string, any>;

/** Axis-aligned bounds. Linear elements carry their extent in width/height. */
export const boundsOf = (el: El) => ({
  x: el.x ?? 0,
  y: el.y ?? 0,
  width: Math.abs(el.width ?? 0),
  height: Math.abs(el.height ?? 0),
  right: (el.x ?? 0) + Math.abs(el.width ?? 0),
  bottom: (el.y ?? 0) + Math.abs(el.height ?? 0),
});

export const textOf = (el: El): string =>
  typeof el.text === "string" ? el.text : "";

/** One line per element — enough to identify it without dumping the scene. */
export const summarize = (el: El) => ({
  id: el.id,
  type: el.type,
  x: Math.round(el.x ?? 0),
  y: Math.round(el.y ?? 0),
  width: Math.round(Math.abs(el.width ?? 0)),
  height: Math.round(Math.abs(el.height ?? 0)),
  ...(textOf(el) ? { text: textOf(el) } : {}),
  ...(el.containerId ? { containerId: el.containerId } : {}),
  ...(el.frameId ? { frameId: el.frameId } : {}),
  ...(el.groupIds?.length ? { groupIds: el.groupIds } : {}),
  ...(el.isDeleted ? { isDeleted: true } : {}),
});

export type FindFilters = {
  type?: string[];
  text?: string;
  ids?: string[];
  group_id?: string;
  frame_id?: string;
  /** Matches elements whose bounds INTERSECT this rectangle. */
  region?: { x: number; y: number; width: number; height: number };
  include_deleted?: boolean;
};

export const findElements = (elements: El[], f: FindFilters): El[] => {
  const needle = f.text?.toLowerCase();
  const idSet = f.ids ? new Set(f.ids) : null;
  return elements.filter((el) => {
    if (!f.include_deleted && el.isDeleted) {
      return false;
    }
    if (idSet && !idSet.has(el.id)) {
      return false;
    }
    if (f.type?.length && !f.type.includes(el.type)) {
      return false;
    }
    if (needle && !textOf(el).toLowerCase().includes(needle)) {
      return false;
    }
    if (f.group_id && !(el.groupIds ?? []).includes(f.group_id)) {
      return false;
    }
    if (f.frame_id && el.frameId !== f.frame_id) {
      return false;
    }
    if (f.region) {
      const b = boundsOf(el);
      const r = f.region;
      const intersects =
        b.x <= r.x + r.width &&
        b.right >= r.x &&
        b.y <= r.y + r.height &&
        b.bottom >= r.y;
      if (!intersects) {
        return false;
      }
    }
    return true;
  });
};

/**
 * Everything attached to one element: the arrows in and out of it, its bound
 * label, the shape it labels, its group siblings and frame. This is what makes
 * a diagram navigable without reading every element.
 */
export const describeElement = (elements: El[], id: string) => {
  const el = elements.find((e) => e.id === id);
  if (!el) {
    return null;
  }
  const byId = new Map(elements.map((e) => [e.id, e]));

  /**
   * What an element reads as: its own text, or — for a shape — the text of the
   * label bound inside it. A rectangle carries no text of its own, so without
   * this "what does this arrow point at" would answer with an empty string.
   */
  const displayText = (target?: El): string => {
    if (!target) {
      return "";
    }
    const own = textOf(target);
    if (own) {
      return own;
    }
    const bound = (target.boundElements ?? []).find(
      (b: El) => b.type === "text",
    );
    return bound ? textOf(byId.get(bound.id) ?? {}) : "";
  };

  const incoming = elements.filter(
    (e) => e.type === "arrow" && e.endBinding?.elementId === id,
  );
  const outgoing = elements.filter(
    (e) => e.type === "arrow" && e.startBinding?.elementId === id,
  );
  const label = (el.boundElements ?? [])
    .filter((b: El) => b.type === "text")
    .map((b: El) => byId.get(b.id))
    .find(Boolean);
  const groupIds: string[] = el.groupIds ?? [];
  const groupSiblings = groupIds.length
    ? elements.filter(
        (e) =>
          e.id !== id &&
          (e.groupIds ?? []).some((g: string) => groupIds.includes(g)),
      )
    : [];

  return {
    element: el,
    relationships: {
      zIndex: elements.indexOf(el),
      incomingArrows: incoming.map((a) => ({
        id: a.id,
        from: a.startBinding?.elementId ?? null,
        fromLabel: a.startBinding
          ? displayText(byId.get(a.startBinding.elementId))
          : null,
      })),
      outgoingArrows: outgoing.map((a) => ({
        id: a.id,
        to: a.endBinding?.elementId ?? null,
        toLabel: a.endBinding
          ? displayText(byId.get(a.endBinding.elementId))
          : null,
      })),
      label: label ? { id: label.id, text: textOf(label) } : null,
      labels: el.containerId ? { containerId: el.containerId } : null,
      groupIds,
      groupSiblingIds: groupSiblings.map((e) => e.id),
      frameId: el.frameId ?? null,
      frameChildIds:
        el.type === "frame"
          ? elements.filter((e) => e.frameId === id).map((e) => e.id)
          : undefined,
    },
  };
};

// -- layout -----------------------------------------------------------------

export type ArrangeOp =
  | "align-left"
  | "align-right"
  | "align-top"
  | "align-bottom"
  | "align-center-x"
  | "align-center-y"
  | "distribute-horizontal"
  | "distribute-vertical"
  | "stack-horizontal"
  | "stack-vertical"
  | "grid";

/**
 * Repositions elements in place and returns how many moved. Only x/y change —
 * nothing is resized, so text and bound labels stay valid.
 */
export const arrangeElements = (
  targets: El[],
  op: ArrangeOp,
  opts: { gap?: number; columns?: number } = {},
): number => {
  if (targets.length === 0) {
    return 0;
  }
  const gap = opts.gap ?? 20;
  const bounds = targets.map(boundsOf);
  const minX = Math.min(...bounds.map((b) => b.x));
  const maxRight = Math.max(...bounds.map((b) => b.right));
  const minY = Math.min(...bounds.map((b) => b.y));
  const maxBottom = Math.max(...bounds.map((b) => b.bottom));
  const centerX = (minX + maxRight) / 2;
  const centerY = (minY + maxBottom) / 2;

  const move = (el: El, x: number, y: number) => {
    // Linear elements keep their points relative to x/y, so translating the
    // origin moves the whole shape — no point rewriting needed.
    el.x = x;
    el.y = y;
  };

  switch (op) {
    case "align-left":
      targets.forEach((el) => move(el, minX, el.y));
      break;
    case "align-right":
      targets.forEach((el, i) => move(el, maxRight - bounds[i].width, el.y));
      break;
    case "align-top":
      targets.forEach((el) => move(el, el.x, minY));
      break;
    case "align-bottom":
      targets.forEach((el, i) => move(el, el.x, maxBottom - bounds[i].height));
      break;
    case "align-center-x":
      targets.forEach((el, i) => move(el, centerX - bounds[i].width / 2, el.y));
      break;
    case "align-center-y":
      targets.forEach((el, i) =>
        move(el, el.x, centerY - bounds[i].height / 2),
      );
      break;
    case "stack-horizontal": {
      const ordered = [...targets].sort((a, b) => a.x - b.x);
      let cursor = minX;
      ordered.forEach((el) => {
        const b = boundsOf(el);
        move(el, cursor, el.y);
        cursor += b.width + gap;
      });
      break;
    }
    case "stack-vertical": {
      const ordered = [...targets].sort((a, b) => a.y - b.y);
      let cursor = minY;
      ordered.forEach((el) => {
        const b = boundsOf(el);
        move(el, el.x, cursor);
        cursor += b.height + gap;
      });
      break;
    }
    case "distribute-horizontal": {
      if (targets.length < 3) {
        return 0;
      }
      const ordered = [...targets].sort((a, b) => a.x - b.x);
      const totalWidth = ordered.reduce((s, el) => s + boundsOf(el).width, 0);
      const span = maxRight - minX;
      const spacing = (span - totalWidth) / (ordered.length - 1);
      let cursor = minX;
      ordered.forEach((el) => {
        move(el, cursor, el.y);
        cursor += boundsOf(el).width + spacing;
      });
      break;
    }
    case "distribute-vertical": {
      if (targets.length < 3) {
        return 0;
      }
      const ordered = [...targets].sort((a, b) => a.y - b.y);
      const totalHeight = ordered.reduce((s, el) => s + boundsOf(el).height, 0);
      const span = maxBottom - minY;
      const spacing = (span - totalHeight) / (ordered.length - 1);
      let cursor = minY;
      ordered.forEach((el) => {
        move(el, el.x, cursor);
        cursor += boundsOf(el).height + spacing;
      });
      break;
    }
    case "grid": {
      const cols = Math.max(
        1,
        opts.columns ?? Math.ceil(Math.sqrt(targets.length)),
      );
      const colWidth = Math.max(...bounds.map((b) => b.width)) + gap;
      const rowHeight = Math.max(...bounds.map((b) => b.height)) + gap;
      targets.forEach((el, i) => {
        move(
          el,
          minX + (i % cols) * colWidth,
          minY + Math.floor(i / cols) * rowHeight,
        );
      });
      break;
    }
  }
  return targets.length;
};

/** Array position IS z-order in Excalidraw; later elements paint on top. */
export const reorderElements = (
  elements: El[],
  ids: string[],
  action: "front" | "back" | "forward" | "backward",
): El[] => {
  const idSet = new Set(ids);
  const moving = elements.filter((e) => idSet.has(e.id));
  const rest = elements.filter((e) => !idSet.has(e.id));
  if (moving.length === 0) {
    return elements;
  }
  switch (action) {
    case "front":
      return [...rest, ...moving];
    case "back":
      return [...moving, ...rest];
    case "forward":
    case "backward": {
      const next = [...elements];
      const indices = next
        .map((e, i) => (idSet.has(e.id) ? i : -1))
        .filter((i) => i >= 0);
      // Walk from the edge we're moving toward, so elements can't leapfrog
      // each other and change their relative order.
      const ordered = action === "forward" ? [...indices].reverse() : indices;
      for (const i of ordered) {
        const target = action === "forward" ? i + 1 : i - 1;
        if (target < 0 || target >= next.length || idSet.has(next[target].id)) {
          continue;
        }
        [next[i], next[target]] = [next[target], next[i]];
      }
      return next;
    }
  }
};

/**
 * Re-centres bound text inside the containers named by `containerIds`.
 *
 * A container's label is a separate element with its own x/y, so moving or
 * resizing a shape leaves its caption behind unless the label is moved too.
 * Excalidraw recomputes this during interactive drags; a scene loaded from
 * JSON keeps whatever was stored, so programmatic edits must do it here.
 *
 * Returns the ids of labels that moved.
 */
export const recenterBoundLabels = (
  elements: El[],
  containerIds: Set<string>,
): string[] => {
  if (containerIds.size === 0) {
    return [];
  }
  const byId = new Map(elements.map((e) => [e.id, e]));
  const moved: string[] = [];
  for (const container of elements) {
    if (!containerIds.has(container.id) || !container.boundElements) {
      continue;
    }
    for (const bound of container.boundElements) {
      if (bound.type !== "text") {
        continue;
      }
      const labelEl = byId.get(bound.id);
      if (!labelEl) {
        continue;
      }
      const b = boundsOf(container);
      const nextX = b.x + (b.width - Math.abs(labelEl.width ?? 0)) / 2;
      const nextY = b.y + (b.height - Math.abs(labelEl.height ?? 0)) / 2;
      if (labelEl.x !== nextX || labelEl.y !== nextY) {
        labelEl.x = nextX;
        labelEl.y = nextY;
        moved.push(labelEl.id);
      }
    }
  }
  return moved;
};

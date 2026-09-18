import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  attachArrowBindings,
  createArrow,
  createBoundLabel,
  createFrame,
  createDiamond,
  createEllipse,
  createLine,
  createRectangle,
  createText,
  ensureTextElementBounds,
  reanchorArrow,
  type BindableElement,
} from "./elements.js";
import {
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  parseShareLink,
  registerWorkspace,
  renameWorkspace,
} from "./registry.js";
import {
  decryptScenePayload,
  downloadSceneVersion,
  encryptScenePayload,
  generateEncryptionKey,
  generateShareId,
  uploadScene,
} from "./scene.js";
import { loadScene, mutateScene, saveScene } from "./scene-ops.js";
import { listVersions, VersionConflictError } from "./versions.js";
import {
  arrangeElements,
  describeElement,
  findElements,
  recenterBoundLabels,
  reorderElements,
  summarize,
  type ArrangeOp,
  type El,
} from "./query.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const APP_BASE_URL = process.env.EXCALIDRAW_APP_URL ?? "";

const workspaceUrl = (shareId: string, key: string) =>
  APP_BASE_URL ? `${APP_BASE_URL}/#json=${shareId},${key}` : null;

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

const json = (value: unknown) => text(JSON.stringify(value, null, 2));

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

// -- shared schema fragments --------------------------------------------------

const baseElementOptions = {
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  opacity: z.number().min(0).max(100).optional(),
  angle: z.number().optional(),
};

const boxArgs = {
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
};

const ref = z
  .string()
  .optional()
  .describe(
    "Optional local alias for this element, usable as an arrow endpoint ({ ref }) by any LATER element in the same call. Not stored in the scene.",
  );

const arrowEndpoint = z
  .union([
    z.object({ x: z.number(), y: z.number() }),
    z.object({ elementId: z.string() }),
    z.object({ ref: z.string() }),
  ])
  .describe(
    "Raw coordinates, an existing element's id, or the `ref` of an element created earlier in this same call.",
  );

const label = z
  .string()
  .optional()
  .describe(
    "Text placed INSIDE this shape as a bound label, so it moves and resizes with the shape. Prefer this over a separate text element for captions.",
  );

const group = z
  .string()
  .optional()
  .describe(
    "Group name local to this call. Elements sharing it become one Excalidraw group, selected and moved together.",
  );

const elementSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"),
    ref,
    label,
    group,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("ellipse"),
    ref,
    label,
    group,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("diamond"),
    ref,
    label,
    group,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("frame"),
    ref,
    group,
    name: z.string().optional().describe("Caption shown above the frame"),
    ...boxArgs,
  }),
  z.object({
    type: z.literal("text"),
    ref,
    group,
    x: z.number(),
    y: z.number(),
    text: z.string(),
    fontSize: z.number().positive().optional(),
    fontFamily: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe("1=Hand-drawn (default), 2=Normal, 3=Code"),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("arrow"),
    ref,
    group,
    label,
    from: arrowEndpoint,
    to: arrowEndpoint,
    startArrowhead: z
      .enum(["arrow", "bar", "dot", "triangle"])
      .nullable()
      .optional(),
    endArrowhead: z
      .enum(["arrow", "bar", "dot", "triangle"])
      .nullable()
      .optional(),
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("line"),
    ref,
    group,
    points: z
      .array(z.array(z.number()).length(2))
      .min(2)
      .describe(
        "Absolute [x, y] canvas coordinates; the first point becomes the element's origin.",
      ),
    ...baseElementOptions,
  }),
]);

type ElementSpec = z.infer<typeof elementSpec>;

/**
 * Builds one element from its spec, resolving arrow endpoints against both the
 * existing scene and the refs of elements created earlier in the same batch.
 * Arrow bindings are attached to their target shapes here so the shapes know
 * about the arrow too.
 */
/**
 * Builds the element(s) for one spec. Returns an array because a shape with a
 * `label` also produces the bound text element that lives inside it.
 *
 * Arrow endpoints resolve against the existing scene and against refs of
 * elements created earlier in the same batch; bindings are attached to their
 * targets here so the shapes know about the arrow too.
 */
const buildElements = (
  spec: ElementSpec,
  sceneElements: BindableElement[],
  refs: Map<string, string>,
  groups: Map<string, string>,
): El[] => {
  const groupIdFor = (name?: string) => {
    if (!name) {
      return undefined;
    }
    if (!groups.has(name)) {
      groups.set(name, randomUUID());
    }
    return [groups.get(name)!];
  };

  const withGroup = (el: El, name?: string) => {
    const ids = groupIdFor(name);
    if (ids) {
      el.groupIds = ids;
    }
    return el;
  };

  switch (spec.type) {
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const make =
        spec.type === "rectangle"
          ? createRectangle
          : spec.type === "ellipse"
          ? createEllipse
          : createDiamond;
      const shape: El = withGroup(make(spec), spec.group);
      if (!spec.label) {
        return [shape];
      }
      // The label registers itself on the shape's boundElements.
      const text = withGroup(
        createBoundLabel(shape as any, spec.label),
        spec.group,
      );
      return [shape, text];
    }
    case "frame":
      return [
        withGroup(createFrame({ ...spec, frameName: spec.name }), spec.group),
      ];
    case "text":
      return [withGroup(createText(spec), spec.group)];
    case "line":
      return [withGroup(createLine(spec), spec.group)];
    case "arrow": {
      const resolveEnd = (end: z.infer<typeof arrowEndpoint>) => {
        if ("ref" in end) {
          const id = refs.get(end.ref);
          if (!id) {
            throw new Error(
              `Arrow references unknown ref "${end.ref}". Refs must belong to an element listed EARLIER in the same call.`,
            );
          }
          return { elementId: id };
        }
        return end;
      };
      const arrow: El = withGroup(
        createArrow(
          { ...spec, from: resolveEnd(spec.from), to: resolveEnd(spec.to) },
          sceneElements,
        ),
        spec.group,
      );
      attachArrowBindings(arrow as any, sceneElements);
      if (!spec.label) {
        return [arrow];
      }
      const text = createBoundLabel(arrow as any, spec.label);
      return [arrow, text];
    }
  }
};

/** Excalidraw uses these to detect a change on load / during sync. */
const bumpVersions = (elements: El[]) => {
  for (const el of elements) {
    el.version = (el.version ?? 1) + 1;
    el.versionNonce = Math.floor(Math.random() * 2 ** 31);
    el.updated = Date.now();
  }
};

/**
 * Re-routes every arrow bound to a shape whose geometry changed, so it still
 * meets the shape's edge. Arrows in `skip` were reshaped explicitly by the
 * caller and must keep the geometry they were given.
 */
const rerouteArrowsFor = (
  elements: El[],
  changedIds: Set<string>,
  skip: Set<string> = new Set(),
): string[] => {
  if (changedIds.size === 0) {
    return [];
  }
  const rerouted: string[] = [];
  for (const el of elements) {
    if (el.type !== "arrow" || skip.has(el.id)) {
      continue;
    }
    const touches =
      changedIds.has(el.startBinding?.elementId) ||
      changedIds.has(el.endBinding?.elementId);
    if (touches && reanchorArrow(el as any, elements as any)) {
      bumpVersions([el]);
      rerouted.push(el.id);
    }
  }
  return rerouted;
};

export const registerTools = (server: McpServer) => {
  // Every tool goes through here so a lost race reads as a clear refusal the
  // caller can act on, rather than an unhandled error with a stack trace.
  const registerTool: McpServer["registerTool"] = (name, config, handler) =>
    server.registerTool(
      name,
      config as any,
      (async (...args: any[]) => {
        try {
          return await (handler as any)(...args);
        } catch (error: any) {
          if (error instanceof VersionConflictError) {
            return failure(error.message);
          }
          throw error;
        }
      }) as any,
    );

  // -- workspace registry ---------------------------------------------------

  registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List all workspaces registered with the MCP server. Returns name, URL (if EXCALIDRAW_APP_URL is set), and last-updated timestamp.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const workspaces = await listWorkspaces();
      return json(
        workspaces.map((ws) => ({
          name: ws.name,
          url: workspaceUrl(ws.shareId, ws.encryptionKey),
          updatedAt: ws.updatedAt,
        })),
      );
    },
  );

  registerTool(
    "register_workspace",
    {
      title: "Register an existing share link",
      description:
        "Register an existing Excalidraw share link as a named workspace. Paste a URL like https://your-app.vercel.app/#json=<id>,<key> and give it a friendly name. Subsequent reads/writes refer to it by name.",
      inputSchema: {
        name: z.string().min(1).describe("Friendly workspace name"),
        share_link_url: z
          .string()
          .url()
          .describe("Full Excalidraw share link URL with #json=id,key hash"),
      },
    },
    async ({ name, share_link_url }) => {
      const parsed = parseShareLink(share_link_url);
      if (!parsed) {
        return failure(
          "Could not parse share link. Expected a URL with #json=<id>,<key>.",
        );
      }
      const entry = await registerWorkspace(name, parsed.id, parsed.key);
      return json({
        ok: true,
        name: entry.name,
        url: workspaceUrl(entry.shareId, entry.encryptionKey),
      });
    },
  );

  registerTool(
    "create_workspace",
    {
      title: "Create a new workspace",
      description:
        "Create a brand-new empty workspace from scratch (mints a fresh share-link id + encryption key, uploads an empty encrypted scene, registers it). Returns the share-link URL you can open in the browser.",
      inputSchema: {
        name: z.string().min(1).describe("Friendly workspace name"),
      },
    },
    async ({ name }) => {
      const shareId = generateShareId();
      const encryptionKey = await generateEncryptionKey();
      const buffer = await encryptScenePayload(
        encryptionKey,
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "my-excalidraw-mcp",
          elements: [],
          appState: {},
        }),
      );
      await uploadScene(shareId, buffer);
      const entry = await registerWorkspace(name, shareId, encryptionKey);
      return json({
        ok: true,
        name: entry.name,
        url: workspaceUrl(entry.shareId, entry.encryptionKey),
      });
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename a workspace",
      description:
        "Rename a registered workspace. The share link / scene blob are unaffected; only the friendly name in the registry changes.",
      inputSchema: {
        current_name: z.string().min(1),
        new_name: z.string().min(1),
      },
    },
    async ({ current_name, new_name }) => {
      const ws = await getWorkspace(current_name);
      if (!ws) {
        return failure(`No workspace named "${current_name}".`);
      }
      await renameWorkspace(current_name, new_name, {
        shareId: ws.shareId,
        encryptionKey: ws.encryptionKey,
      });
      return json({ ok: true, oldName: current_name, newName: new_name });
    },
  );

  registerTool(
    "delete_workspace",
    {
      title: "Forget a workspace",
      description:
        "Remove a workspace entry from the MCP registry. The scene blob in Firebase Storage is NOT deleted (so the share link still works); this only forgets the friendly name binding.",
      inputSchema: { name: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      await deleteWorkspace(name);
      return text(`Forgot workspace "${name}".`);
    },
  );

  // -- scene reads ----------------------------------------------------------

  registerTool(
    "read_workspace",
    {
      title: "Read a workspace scene",
      description:
        'Read a registered workspace\'s scene. Defaults to mode="summary": one compact line per element (id, type, position, size, any text) plus per-type counts — enough to locate elements and then edit them with update_elements or delete_elements. Pass mode="full" only when you need the raw Excalidraw elements array (large), e.g. before replace_workspace.',
      inputSchema: {
        name: z.string().min(1).describe("Friendly workspace name"),
        mode: z
          .enum(["summary", "full"])
          .default("summary")
          .describe(
            '"summary" (default, compact) or "full" (complete elements + appState)',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, mode }) => {
      const ws = await getWorkspace(name);
      if (!ws) {
        return failure(`No workspace named "${name}".`);
      }
      // Via loadScene so a workspace whose blob doesn't exist yet reads as an
      // empty scene instead of throwing a 404 out of Storage.
      const { scene } = await loadScene(name);
      const url = workspaceUrl(ws.shareId, ws.encryptionKey);

      if (mode === "full") {
        return json({
          name: ws.name,
          url,
          elements: scene.elements,
          appState: scene.appState,
        });
      }

      const countsByType: Record<string, number> = {};
      for (const el of scene.elements) {
        countsByType[el.type] = (countsByType[el.type] ?? 0) + 1;
      }
      return json({
        name: ws.name,
        url,
        elementCount: scene.elements.length,
        countsByType,
        elements: scene.elements.map((el: any) => ({
          id: el.id,
          type: el.type,
          x: Math.round(el.x),
          y: Math.round(el.y),
          width: Math.round(el.width),
          height: Math.round(el.height),
          ...(el.text ? { text: el.text } : {}),
          ...(el.isDeleted ? { isDeleted: true } : {}),
        })),
      });
    },
  );

  // -- scene writes ---------------------------------------------------------

  registerTool(
    "add_elements",
    {
      title: "Add elements to a workspace",
      description:
        "Append one or more elements to a workspace in a SINGLE round-trip. Prefer this over repeated single-element calls: each call downloads, decrypts, re-encrypts and re-uploads the whole scene, so batching a diagram into one call is both far faster and free of the last-write-wins clobbering that concurrent calls cause. Give an element a `ref` and a later arrow in the same call can point at it via { ref }, so shapes and the arrows between them can be created together. Returns the new element ids.",
      inputSchema: {
        name: z.string().min(1),
        elements: z.array(elementSpec).min(1),
      },
    },
    async ({ name, elements: specs }) => {
      const { scene, shareId, encryptionKey, version } = await loadScene(name);
      const refs = new Map<string, string>();
      const groups = new Map<string, string>();
      const created: { ref?: string; id: string; type: string }[] = [];

      for (const spec of specs) {
        let built: El[];
        try {
          built = buildElements(spec, scene.elements, refs, groups);
        } catch (error: any) {
          // Nothing has been saved yet, so the scene is untouched.
          return failure(error.message);
        }
        // built[0] is the element itself; anything after is its bound label.
        const [primary] = built;
        scene.elements.push(...built);
        if (spec.ref) {
          refs.set(spec.ref, primary.id);
        }
        for (const el of built) {
          created.push({
            ...(el.id === primary.id && spec.ref ? { ref: spec.ref } : {}),
            id: el.id,
            type: el.type,
          });
        }
      }

      const committed = await saveScene(
        name,
        scene,
        shareId,
        encryptionKey,
        version,
        `Added ${created.length} element${created.length === 1 ? "" : "s"}`,
      );
      return json({
        ok: true,
        name,
        added: created,
        elementCount: scene.elements.length,
        version: committed,
      });
    },
  );

  registerTool(
    "update_elements",
    {
      title: "Update existing elements",
      description:
        "Change existing elements in place by id — move (x/y absolute or dx/dy relative), resize, restyle, or edit text — in a single round-trip. Use this instead of reading the whole scene and calling replace_workspace. Text elements are re-measured when their text or fontSize changes and no explicit width/height is given.",
      inputSchema: {
        name: z.string().min(1),
        updates: z
          .array(
            z.object({
              id: z.string().describe("Element id, from read_workspace"),
              x: z.number().optional().describe("New absolute x"),
              y: z.number().optional().describe("New absolute y"),
              dx: z.number().optional().describe("Shift x by this much"),
              dy: z.number().optional().describe("Shift y by this much"),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
              text: z.string().optional().describe("Text elements only"),
              points: z
                .array(z.array(z.number()).length(2))
                .min(2)
                .optional()
                .describe(
                  "Arrow/line elements only: absolute [x, y] canvas coordinates. The first point becomes the element's origin; the rest are stored relative to it. Replaces the element's whole shape.",
                ),
              fontSize: z.number().positive().optional(),
              locked: z.boolean().optional(),
              ...baseElementOptions,
            }),
          )
          .min(1),
      },
    },
    async ({ name, updates }) => {
      const { scene, shareId, encryptionKey, version } = await loadScene(name);
      const byId = new Map<string, any>(
        scene.elements.map((el: any) => [el.id, el]),
      );
      // Arrows bound to a shape whose geometry we change need re-routing.
      const movedShapeIds = new Set<string>();
      // ...except ones the caller reshaped explicitly via `points`.
      const reshapedIds = new Set<string>();

      const missing = updates.filter((u) => !byId.has(u.id)).map((u) => u.id);
      if (missing.length) {
        // All-or-nothing: a partial apply would leave the caller unsure which
        // of their updates landed.
        return failure(
          `No such element(s) in "${name}": ${missing.join(
            ", ",
          )}. Call read_workspace for current ids.`,
        );
      }

      for (const { id, dx, dy, text: newText, points, ...patch } of updates) {
        const el = byId.get(id)!;

        if (points) {
          // Same rebasing rule as createLine: absolute in, relative out.
          const [originX, originY] = points[0];
          el.x = originX;
          el.y = originY;
          el.points = points.map((pt) => [pt[0] - originX, pt[1] - originY]);
          const xs = el.points.map((pt: number[]) => pt[0]);
          const ys = el.points.map((pt: number[]) => pt[1]);
          el.width = Math.max(...xs) - Math.min(...xs);
          el.height = Math.max(...ys) - Math.min(...ys);
        }
        const retextured =
          newText !== undefined || patch.fontSize !== undefined;

        Object.assign(
          el,
          Object.fromEntries(
            Object.entries(patch).filter(([, v]) => v !== undefined),
          ),
        );
        if (newText !== undefined) {
          el.text = newText;
          el.originalText = newText;
        }
        if (dx !== undefined) {
          el.x += dx;
        }
        if (dy !== undefined) {
          el.y += dy;
        }

        // Re-measure text whose content/size changed unless the caller sized
        // it explicitly; clearing the bounds lets the shared helper recompute.
        if (
          el.type === "text" &&
          retextured &&
          patch.width === undefined &&
          patch.height === undefined
        ) {
          delete el.width;
          delete el.height;
          Object.assign(el, ensureTextElementBounds(el));
        }

        if (points) {
          reshapedIds.add(el.id);
        }

        if (
          points !== undefined ||
          dx !== undefined ||
          dy !== undefined ||
          patch.x !== undefined ||
          patch.y !== undefined ||
          patch.width !== undefined ||
          patch.height !== undefined
        ) {
          movedShapeIds.add(el.id);
        }

        bumpVersions([el]);
      }

      const movedLabels = recenterBoundLabels(scene.elements, movedShapeIds);
      bumpVersions(
        scene.elements.filter((el: El) => movedLabels.includes(el.id)),
      );
      const rerouted = rerouteArrowsFor(
        scene.elements,
        movedShapeIds,
        reshapedIds,
      );

      const committed = await saveScene(
        name,
        scene,
        shareId,
        encryptionKey,
        version,
        `Updated ${updates.length} element${updates.length === 1 ? "" : "s"}`,
      );
      return json({
        ok: true,
        name,
        version: committed,
        updated: updates.map((u) => u.id),
        ...(rerouted.length ? { reroutedArrows: rerouted } : {}),
        elementCount: scene.elements.length,
      });
    },
  );

  // -- navigation -----------------------------------------------------------

  registerTool(
    "find_elements",
    {
      title: "Find elements",
      description:
        "Search a workspace's elements by type, text, region, group or frame, returning compact summaries. Use this instead of reading the whole scene when you need to locate something — e.g. every arrow, or every element whose text mentions 'auth', or everything inside a rectangle of canvas space.",
      inputSchema: {
        name: z.string().min(1),
        type: z
          .array(z.string())
          .optional()
          .describe('Element types to include, e.g. ["rectangle","arrow"]'),
        text: z
          .string()
          .optional()
          .describe("Case-insensitive substring match against element text"),
        ids: z.array(z.string()).optional(),
        group_id: z.string().optional(),
        frame_id: z.string().optional(),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional()
          .describe("Canvas rectangle; matches elements that INTERSECT it"),
        include_deleted: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, limit, ...filters }) => {
      const { scene } = await loadScene(name);
      const matches = findElements(scene.elements, filters);
      return json({
        name,
        matched: matches.length,
        returned: Math.min(matches.length, limit),
        elements: matches.slice(0, limit).map(summarize),
      });
    },
  );

  registerTool(
    "describe_element",
    {
      title: "Describe an element and its relationships",
      description:
        "Full detail for one element plus what it is connected to: arrows in and out (with the text of what they connect to), its bound label, group siblings, frame membership and z-index. This is how to follow a diagram's structure without reading every element.",
      inputSchema: {
        name: z.string().min(1),
        element_id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, element_id }) => {
      const { scene } = await loadScene(name);
      const described = describeElement(scene.elements, element_id);
      if (!described) {
        return failure(`No element "${element_id}" in "${name}".`);
      }
      return json(described);
    },
  );

  // -- layout and structure ---------------------------------------------------

  registerTool(
    "arrange_elements",
    {
      title: "Align, distribute or lay out elements",
      description:
        "Reposition elements as a set: align them on an edge or centre, distribute them evenly, stack them with a gap, or lay them out in a grid. Only positions change — nothing is resized, so text and bound labels stay intact. Arrows bound to anything that moves are re-routed.",
      inputSchema: {
        name: z.string().min(1),
        element_ids: z.array(z.string()).min(2),
        operation: z.enum([
          "align-left",
          "align-right",
          "align-top",
          "align-bottom",
          "align-center-x",
          "align-center-y",
          "distribute-horizontal",
          "distribute-vertical",
          "stack-horizontal",
          "stack-vertical",
          "grid",
        ]),
        gap: z
          .number()
          .optional()
          .describe("Spacing for stack/grid operations (default 20)"),
        columns: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Grid columns (default: roughly square)"),
      },
    },
    async ({ name, element_ids, operation, gap, columns }) => {
      const { scene, shareId, encryptionKey, version } = await loadScene(name);
      const idSet = new Set(element_ids);
      const targets = scene.elements.filter((el: El) => idSet.has(el.id));
      const missing = element_ids.filter(
        (id) => !targets.some((el: El) => el.id === id),
      );
      if (missing.length) {
        return failure(
          `No such element(s) in "${name}": ${missing.join(", ")}.`,
        );
      }
      const moved = arrangeElements(targets, operation as ArrangeOp, {
        gap,
        columns,
      });
      if (moved === 0) {
        return failure(
          `"${operation}" needs at least 3 elements to be meaningful.`,
        );
      }
      bumpVersions(targets);
      const movedLabels = recenterBoundLabels(scene.elements, idSet);
      bumpVersions(
        scene.elements.filter((el: El) => movedLabels.includes(el.id)),
      );
      const rerouted = rerouteArrowsFor(scene.elements, idSet);
      const committed = await saveScene(
        name,
        scene,
        shareId,
        encryptionKey,
        version,
        `Arranged ${moved} elements (${operation})`,
      );
      return json({
        ok: true,
        name,
        operation,
        moved,
        ...(rerouted.length ? { reroutedArrows: rerouted } : {}),
        version: committed,
      });
    },
  );

  registerTool(
    "organize_elements",
    {
      title: "Group, ungroup or restack elements",
      description:
        "Structural edits that are not about position: group elements so they select and move together, ungroup them, or change their z-order (which element paints on top).",
      inputSchema: {
        name: z.string().min(1),
        element_ids: z.array(z.string()).min(1),
        action: z.enum([
          "group",
          "ungroup",
          "bring-to-front",
          "send-to-back",
          "bring-forward",
          "send-backward",
        ]),
      },
    },
    async ({ name, element_ids, action }) => {
      const { scene, shareId, encryptionKey, version } = await loadScene(name);
      const idSet = new Set(element_ids);
      const targets = scene.elements.filter((el: El) => idSet.has(el.id));
      if (targets.length !== element_ids.length) {
        const missing = element_ids.filter(
          (id) => !targets.some((el: El) => el.id === id),
        );
        return failure(
          `No such element(s) in "${name}": ${missing.join(", ")}.`,
        );
      }

      let detail: Record<string, unknown> = {};
      if (action === "group") {
        const groupId = randomUUID();
        for (const el of targets) {
          el.groupIds = [...(el.groupIds ?? []), groupId];
        }
        detail = { groupId };
      } else if (action === "ungroup") {
        // Drop only the innermost group, so nested grouping survives.
        for (const el of targets) {
          el.groupIds = (el.groupIds ?? []).slice(0, -1);
        }
      } else {
        const map: Record<string, "front" | "back" | "forward" | "backward"> = {
          "bring-to-front": "front",
          "send-to-back": "back",
          "bring-forward": "forward",
          "send-backward": "backward",
        };
        scene.elements = reorderElements(
          scene.elements,
          element_ids,
          map[action],
        );
      }
      bumpVersions(targets);
      const committed = await saveScene(
        name,
        scene,
        shareId,
        encryptionKey,
        version,
        `${action} ${targets.length} element${targets.length === 1 ? "" : "s"}`,
      );
      return json({
        ok: true,
        name,
        action,
        count: targets.length,
        ...detail,
        version: committed,
      });
    },
  );

  // -- version history ------------------------------------------------------

  registerTool(
    "list_versions",
    {
      title: "List scene versions",
      description:
        "List the saved versions of a workspace's scene, newest first. Every write from the app or the MCP creates one. Use the version number with restore_version.",
      inputSchema: {
        name: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, limit }) => {
      const ws = await getWorkspace(name);
      if (!ws) {
        return failure(`No workspace named "${name}".`);
      }
      const versions = await listVersions(ws.shareId, limit);
      return json({ name, current: versions[0]?.version ?? 0, versions });
    },
  );

  registerTool(
    "restore_version",
    {
      title: "Restore a scene version",
      description:
        "Roll a workspace's scene back to an earlier version. This is non-destructive: the restored content is committed as a NEW version on top of the history, so nothing is lost and the restore can itself be undone.",
      inputSchema: {
        name: z.string().min(1),
        version: z.number().int().min(1).describe("Version from list_versions"),
      },
    },
    async ({ name, version }) => {
      const ws = await getWorkspace(name);
      if (!ws) {
        return failure(`No workspace named "${name}".`);
      }
      const { version: currentVersion } = await loadScene(name);
      if (version > currentVersion) {
        return failure(
          `Version ${version} does not exist (current is ${currentVersion}).`,
        );
      }
      let snapshot;
      try {
        const blob = await downloadSceneVersion(ws.shareId, version);
        snapshot = JSON.parse(
          await decryptScenePayload(ws.encryptionKey, blob),
        );
      } catch {
        return failure(
          `Version ${version} has no stored snapshot. Versions written before history was enabled cannot be restored.`,
        );
      }
      const committed = await saveScene(
        name,
        snapshot,
        ws.shareId,
        ws.encryptionKey,
        currentVersion,
        `Restored version ${version}`,
      );
      return json({
        ok: true,
        name,
        restoredFrom: version,
        version: committed,
        elementCount: snapshot.elements?.length ?? 0,
      });
    },
  );

  registerTool(
    "replace_workspace",
    {
      title: "Replace a workspace scene",
      description:
        'Overwrite the scene of a registered workspace. Pass the full elements array you want the workspace to contain (this REPLACES the scene, it does not append) — so read it with mode="full" first if you mean to preserve existing content. Prefer add_elements / update_elements / delete_elements for incremental changes.',
      inputSchema: {
        name: z.string().min(1),
        elements: z.array(z.record(z.any())),
        appState: z.record(z.any()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, elements, appState }) => {
      const { shareId, encryptionKey, version } = await loadScene(name);
      const normalizedElements = elements.map(ensureTextElementBounds);
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "my-excalidraw-mcp",
        elements: normalizedElements,
        appState: appState ?? {},
      };
      const committed = await saveScene(
        name,
        scene,
        shareId,
        encryptionKey,
        version,
        "Replaced scene",
      );
      return json({
        ok: true,
        name,
        url: workspaceUrl(shareId, encryptionKey),
        elementCount: normalizedElements.length,
        version: committed,
      });
    },
  );

  registerTool(
    "clear_workspace",
    {
      title: "Clear a workspace scene",
      description:
        "Remove all elements from a workspace's scene (keeps the registry entry and share link working).",
      inputSchema: { name: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ name }) => {
      const { elementCount } = await mutateScene(name, (scene) => {
        scene.elements = [];
      });
      return json({ ok: true, name, elementCount });
    },
  );

  registerTool(
    "delete_elements",
    {
      title: "Delete elements",
      description:
        "Remove specific elements from a workspace by their IDs. Any arrow bound to a deleted shape has that binding dropped so it doesn't point at a missing element.",
      inputSchema: {
        name: z.string().min(1),
        element_ids: z.array(z.string()).min(1),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, element_ids }) => {
      const idSet = new Set(element_ids);
      let removed = 0;
      const { elementCount } = await mutateScene(name, (scene) => {
        const before = scene.elements.length;
        scene.elements = scene.elements.filter((el: any) => !idSet.has(el.id));
        removed = before - scene.elements.length;

        // Scrub references to the removed elements, otherwise arrows keep
        // dangling bindings and shapes keep dead boundElements entries.
        for (const el of scene.elements) {
          if (el.startBinding && idSet.has(el.startBinding.elementId)) {
            el.startBinding = null;
          }
          if (el.endBinding && idSet.has(el.endBinding.elementId)) {
            el.endBinding = null;
          }
          if (el.boundElements?.some((b: any) => idSet.has(b.id))) {
            el.boundElements = el.boundElements.filter(
              (b: any) => !idSet.has(b.id),
            );
          }
        }
      });
      return json({ ok: true, name, removed, elementCount });
    },
  );
};

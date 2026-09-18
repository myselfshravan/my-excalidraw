import { z } from "zod";

import {
  attachArrowBindings,
  createArrow,
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
  encryptScenePayload,
  generateEncryptionKey,
  generateShareId,
  uploadScene,
} from "./scene.js";
import { loadScene, mutateScene, saveScene } from "./scene-ops.js";

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

const elementSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"),
    ref,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("ellipse"),
    ref,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("diamond"),
    ref,
    ...boxArgs,
    ...baseElementOptions,
  }),
  z.object({
    type: z.literal("text"),
    ref,
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
const buildElement = (
  spec: ElementSpec,
  sceneElements: BindableElement[],
  refs: Map<string, string>,
) => {
  switch (spec.type) {
    case "rectangle":
      return createRectangle(spec);
    case "ellipse":
      return createEllipse(spec);
    case "diamond":
      return createDiamond(spec);
    case "text":
      return createText(spec);
    case "line":
      return createLine(spec);
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
      const arrow = createArrow(
        { ...spec, from: resolveEnd(spec.from), to: resolveEnd(spec.to) },
        sceneElements,
      );
      attachArrowBindings(arrow, sceneElements);
      return arrow;
    }
  }
};

export const registerTools = (server: McpServer) => {
  // -- workspace registry ---------------------------------------------------

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
      const { scene, shareId, encryptionKey } = await loadScene(name);
      const refs = new Map<string, string>();
      const created: { ref?: string; id: string; type: string }[] = [];

      for (const spec of specs) {
        let el;
        try {
          el = buildElement(spec, scene.elements, refs);
        } catch (error: any) {
          // Nothing has been saved yet, so the scene is untouched.
          return failure(error.message);
        }
        scene.elements.push(el);
        if (spec.ref) {
          refs.set(spec.ref, el.id);
        }
        created.push({
          ...(spec.ref ? { ref: spec.ref } : {}),
          id: el.id,
          type: el.type,
        });
      }

      await saveScene(name, scene, shareId, encryptionKey);
      return json({
        ok: true,
        name,
        added: created,
        elementCount: scene.elements.length,
      });
    },
  );

  server.registerTool(
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
              fontSize: z.number().positive().optional(),
              locked: z.boolean().optional(),
              ...baseElementOptions,
            }),
          )
          .min(1),
      },
    },
    async ({ name, updates }) => {
      const { scene, shareId, encryptionKey } = await loadScene(name);
      const byId = new Map<string, any>(
        scene.elements.map((el: any) => [el.id, el]),
      );
      // Arrows bound to a shape whose geometry we change need re-routing.
      const movedShapeIds = new Set<string>();

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

      for (const { id, dx, dy, text: newText, ...patch } of updates) {
        const el = byId.get(id)!;
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

        if (
          dx !== undefined ||
          dy !== undefined ||
          patch.x !== undefined ||
          patch.y !== undefined ||
          patch.width !== undefined ||
          patch.height !== undefined
        ) {
          movedShapeIds.add(el.id);
        }

        // Excalidraw uses these to detect a change on load / during sync.
        el.version = (el.version ?? 1) + 1;
        el.versionNonce = Math.floor(Math.random() * 2 ** 31);
        el.updated = Date.now();
      }

      // Re-route every arrow bound to something that moved, so it still meets
      // the shape's edge instead of dangling or ending up inside it.
      const rerouted: string[] = [];
      if (movedShapeIds.size) {
        for (const el of scene.elements as any[]) {
          if (el.type !== "arrow") {
            continue;
          }
          const touches =
            movedShapeIds.has(el.startBinding?.elementId) ||
            movedShapeIds.has(el.endBinding?.elementId);
          if (touches && reanchorArrow(el, scene.elements)) {
            el.version = (el.version ?? 1) + 1;
            el.versionNonce = Math.floor(Math.random() * 2 ** 31);
            el.updated = Date.now();
            rerouted.push(el.id);
          }
        }
      }

      await saveScene(name, scene, shareId, encryptionKey);
      return json({
        ok: true,
        name,
        updated: updates.map((u) => u.id),
        ...(rerouted.length ? { reroutedArrows: rerouted } : {}),
        elementCount: scene.elements.length,
      });
    },
  );

  server.registerTool(
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
      const { shareId, encryptionKey } = await loadScene(name);
      const normalizedElements = elements.map(ensureTextElementBounds);
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "my-excalidraw-mcp",
        elements: normalizedElements,
        appState: appState ?? {},
      };
      await saveScene(name, scene, shareId, encryptionKey);
      return json({
        ok: true,
        name,
        url: workspaceUrl(shareId, encryptionKey),
        elementCount: normalizedElements.length,
      });
    },
  );

  server.registerTool(
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

  server.registerTool(
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

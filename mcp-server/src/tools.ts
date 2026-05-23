import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  createArrow,
  createDiamond,
  createEllipse,
  createLine,
  createRectangle,
  createText,
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
  downloadScene,
  encryptScenePayload,
  generateEncryptionKey,
  generateShareId,
  uploadScene,
} from "./scene.js";
import { loadScene, mutateScene, saveScene } from "./scene-ops.js";

const APP_BASE_URL = process.env.EXCALIDRAW_APP_URL ?? "";

const workspaceUrl = (shareId: string, key: string) =>
  APP_BASE_URL ? `${APP_BASE_URL}/#json=${shareId},${key}` : null;

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

const json = (value: unknown) => text(JSON.stringify(value, null, 2));

const baseElementOptions = {
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z
    .union([z.literal(1), z.literal(2), z.literal(4)])
    .optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  opacity: z.number().min(0).max(100).optional(),
  angle: z.number().optional(),
};

const shapeArgs = {
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  ...baseElementOptions,
};

export const registerTools = (server: McpServer) => {
  // -- workspace registry ---------------------------------------------------

  server.tool(
    "list_workspaces",
    "List all workspaces registered with the MCP server. Returns name, URL (if EXCALIDRAW_APP_URL is set), and last-updated timestamp.",
    {},
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

  server.tool(
    "register_workspace",
    "Register an existing Excalidraw share link as a named workspace. Paste a URL like https://your-app.vercel.app/#json=<id>,<key> and give it a friendly name. Subsequent reads/writes refer to it by name.",
    {
      name: z.string().min(1).describe("Friendly workspace name"),
      share_link_url: z
        .string()
        .url()
        .describe("Full Excalidraw share link URL with #json=id,key hash"),
    },
    async ({ name, share_link_url }) => {
      const parsed = parseShareLink(share_link_url);
      if (!parsed) {
        return text(
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

  server.tool(
    "create_workspace",
    "Create a brand-new empty workspace from scratch (mints a fresh share-link id + encryption key, uploads an empty encrypted scene, registers it). Returns the share-link URL you can open in the browser.",
    {
      name: z.string().min(1).describe("Friendly workspace name"),
    },
    async ({ name }) => {
      const shareId = generateShareId();
      const encryptionKey = await generateEncryptionKey();
      const emptyScene = {
        type: "excalidraw",
        version: 2,
        source: "my-excalidraw-mcp",
        elements: [],
        appState: {},
      };
      const buffer = await encryptScenePayload(
        encryptionKey,
        JSON.stringify(emptyScene),
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

  server.tool(
    "rename_workspace",
    "Rename a registered workspace. The share link / scene blob are unaffected; only the friendly name in the registry changes.",
    {
      current_name: z.string().min(1),
      new_name: z.string().min(1),
    },
    async ({ current_name, new_name }) => {
      const ws = await getWorkspace(current_name);
      if (!ws) {
        return text(`No workspace named "${current_name}".`);
      }
      await renameWorkspace(current_name, new_name, {
        shareId: ws.shareId,
        encryptionKey: ws.encryptionKey,
      });
      return json({ ok: true, oldName: current_name, newName: new_name });
    },
  );

  server.tool(
    "delete_workspace",
    "Remove a workspace entry from the MCP registry. The scene blob in Firebase Storage is NOT deleted (so the share link still works); this only forgets the friendly name binding.",
    {
      name: z.string().min(1),
    },
    async ({ name }) => {
      await deleteWorkspace(name);
      return text(`Forgot workspace "${name}".`);
    },
  );

  // -- scene reads ----------------------------------------------------------

  server.tool(
    "read_workspace",
    "Read the current scene of a registered workspace. Returns the Excalidraw elements array and appState as JSON.",
    {
      name: z.string().min(1).describe("Friendly workspace name"),
    },
    async ({ name }) => {
      const ws = await getWorkspace(name);
      if (!ws) {
        return text(`No workspace named "${name}".`);
      }
      const blob = await downloadScene(ws.shareId);
      const sceneJSON = await decryptScenePayload(ws.encryptionKey, blob);
      const scene = JSON.parse(sceneJSON);
      return json({
        name: ws.name,
        url: workspaceUrl(ws.shareId, ws.encryptionKey),
        elements: scene.elements ?? [],
        appState: scene.appState ?? {},
      });
    },
  );

  // -- scene writes ---------------------------------------------------------

  server.tool(
    "replace_workspace",
    "Overwrite the scene of a registered workspace. Pass the full elements array you want the workspace to contain (this REPLACES the current scene, not append). Use add_* tools for incremental changes.",
    {
      name: z.string().min(1),
      elements: z.array(z.record(z.any())),
      appState: z.record(z.any()).optional(),
    },
    async ({ name, elements, appState }) => {
      const { shareId, encryptionKey } = await loadScene(name);
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "my-excalidraw-mcp",
        elements,
        appState: appState ?? {},
      };
      await saveScene(name, scene, shareId, encryptionKey);
      return json({
        ok: true,
        name,
        url: workspaceUrl(shareId, encryptionKey),
        elementCount: elements.length,
      });
    },
  );

  server.tool(
    "clear_workspace",
    "Remove all elements from a workspace's scene (keeps the registry entry and share link working).",
    {
      name: z.string().min(1),
    },
    async ({ name }) => {
      const { elementCount } = await mutateScene(name, (scene) => {
        scene.elements = [];
      });
      return json({ ok: true, name, elementCount });
    },
  );

  server.tool(
    "delete_elements",
    "Remove specific elements from a workspace by their IDs.",
    {
      name: z.string().min(1),
      element_ids: z.array(z.string()),
    },
    async ({ name, element_ids }) => {
      const idSet = new Set(element_ids);
      const { elementCount } = await mutateScene(name, (scene) => {
        scene.elements = scene.elements.filter((el: any) => !idSet.has(el.id));
      });
      return json({ ok: true, name, elementCount });
    },
  );

  // -- element helpers ------------------------------------------------------

  server.tool(
    "add_rectangle",
    "Append a rectangle to a workspace. Returns the new element's id so you can reference it (e.g. as an arrow endpoint).",
    {
      name: z.string().min(1),
      ...shapeArgs,
    },
    async ({ name, ...args }) => {
      const el = createRectangle(args);
      await mutateScene(name, (scene) => {
        scene.elements.push(el);
      });
      return json({ ok: true, id: el.id, type: el.type });
    },
  );

  server.tool(
    "add_ellipse",
    "Append an ellipse to a workspace.",
    {
      name: z.string().min(1),
      ...shapeArgs,
    },
    async ({ name, ...args }) => {
      const el = createEllipse(args);
      await mutateScene(name, (scene) => {
        scene.elements.push(el);
      });
      return json({ ok: true, id: el.id, type: el.type });
    },
  );

  server.tool(
    "add_diamond",
    "Append a diamond to a workspace.",
    {
      name: z.string().min(1),
      ...shapeArgs,
    },
    async ({ name, ...args }) => {
      const el = createDiamond(args);
      await mutateScene(name, (scene) => {
        scene.elements.push(el);
      });
      return json({ ok: true, id: el.id, type: el.type });
    },
  );

  server.tool(
    "add_text",
    "Append a text element to a workspace.",
    {
      name: z.string().min(1),
      x: z.number(),
      y: z.number(),
      text_content: z.string(),
      fontSize: z.number().positive().optional(),
      fontFamily: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .optional()
        .describe("1=Hand-drawn (default), 2=Normal, 3=Code"),
      textAlign: z.enum(["left", "center", "right"]).optional(),
      verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
      ...baseElementOptions,
    },
    async ({ name, text_content, ...args }) => {
      const el = createText({ ...args, text: text_content });
      await mutateScene(name, (scene) => {
        scene.elements.push(el);
      });
      return json({ ok: true, id: el.id, type: el.type });
    },
  );

  server.tool(
    "add_arrow",
    "Append an arrow to a workspace. Endpoints can be raw coordinates ({x,y}) or refer to an existing element by id (creates a binding so the arrow follows the element).",
    {
      name: z.string().min(1),
      from: z.union([
        z.object({ x: z.number(), y: z.number() }),
        z.object({ elementId: z.string() }),
      ]),
      to: z.union([
        z.object({ x: z.number(), y: z.number() }),
        z.object({ elementId: z.string() }),
      ]),
      startArrowhead: z
        .enum(["arrow", "bar", "dot", "triangle"])
        .nullable()
        .optional(),
      endArrowhead: z
        .enum(["arrow", "bar", "dot", "triangle"])
        .nullable()
        .optional(),
      ...baseElementOptions,
    },
    async ({ name, from, to, ...args }) => {
      const { scene, shareId, encryptionKey } = await loadScene(name);
      const el = createArrow({ from, to, ...args }, scene.elements);
      scene.elements.push(el);
      await saveScene(name, scene, shareId, encryptionKey);
      return json({ ok: true, id: el.id, type: el.type });
    },
  );

  server.tool(
    "add_line",
    "Append a polyline to a workspace.",
    {
      name: z.string().min(1),
      points: z
        .array(z.tuple([z.number(), z.number()]))
        .min(2)
        .describe("Array of [x, y] points; first point is the line's origin"),
      ...baseElementOptions,
    },
    async ({ name, points, ...args }) => {
      const el = createLine({ ...args, points });
      await mutateScene(name, (scene) => {
        scene.elements.push(el);
      });
      return json({ ok: true, id: el.id, type: el.type });
    },
  );
};

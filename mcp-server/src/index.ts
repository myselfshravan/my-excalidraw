#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  parseShareLink,
  registerWorkspace,
  touchWorkspace,
} from "./registry.js";
import {
  decryptScenePayload,
  downloadScene,
  encryptScenePayload,
  uploadScene,
} from "./scene.js";

const APP_BASE_URL = process.env.EXCALIDRAW_APP_URL ?? "";

const server = new McpServer({
  name: "my-excalidraw-mcp",
  version: "0.1.0",
});

const workspaceUrl = (shareId: string, key: string) =>
  APP_BASE_URL ? `${APP_BASE_URL}/#json=${shareId},${key}` : null;

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

const json = (value: unknown) => text(JSON.stringify(value, null, 2));

server.tool(
  "list_workspaces",
  "List all workspaces registered with the MCP server. Each entry includes the friendly name and (if EXCALIDRAW_APP_URL is set) a browser URL to open it.",
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
        `Could not parse share link. Expected a URL with #json=<id>,<key>.`,
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
  "read_workspace",
  "Read the current scene of a registered workspace. Returns the Excalidraw elements array and appState as JSON.",
  {
    name: z.string().min(1).describe("Friendly workspace name"),
  },
  async ({ name }) => {
    const ws = await getWorkspace(name);
    if (!ws) {
      return text(`No workspace named "${name}". Use list_workspaces to see registered names, or register_workspace to add one.`);
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

server.tool(
  "update_workspace",
  "Overwrite the scene of a registered workspace. Pass the full elements array you want the workspace to contain (this REPLACES the current scene, it does not append).",
  {
    name: z.string().min(1).describe("Friendly workspace name"),
    elements: z
      .array(z.record(z.any()))
      .describe("Full elements array to write (replaces the existing scene)"),
    appState: z
      .record(z.any())
      .optional()
      .describe("Optional partial appState to persist alongside elements"),
  },
  async ({ name, elements, appState }) => {
    const ws = await getWorkspace(name);
    if (!ws) {
      return text(`No workspace named "${name}".`);
    }
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "my-excalidraw-mcp",
      elements,
      appState: appState ?? {},
    };
    const buffer = await encryptScenePayload(
      ws.encryptionKey,
      JSON.stringify(scene),
    );
    await uploadScene(ws.shareId, buffer);
    await touchWorkspace(name);
    return json({
      ok: true,
      name: ws.name,
      url: workspaceUrl(ws.shareId, ws.encryptionKey),
      elementCount: elements.length,
    });
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

const transport = new StdioServerTransport();
await server.connect(transport);

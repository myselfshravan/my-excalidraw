// High-level scene mutations: fetch -> decrypt -> mutate -> encrypt -> upload.
// Used by both the raw `update_workspace` tool and the per-element helpers.

import { getWorkspace, touchWorkspace } from "./registry.js";
import {
  decryptScenePayload,
  downloadScene,
  encryptScenePayload,
  uploadScene,
} from "./scene.js";

export type Scene = {
  type: string;
  version: number;
  source: string;
  elements: any[];
  appState: Record<string, any>;
};

const emptyScene = (): Scene => ({
  type: "excalidraw",
  version: 2,
  source: "my-excalidraw-mcp",
  elements: [],
  appState: {},
});

export const loadScene = async (workspaceName: string): Promise<{
  scene: Scene;
  shareId: string;
  encryptionKey: string;
}> => {
  const ws = await getWorkspace(workspaceName);
  if (!ws) {
    throw new Error(`No workspace named "${workspaceName}"`);
  }
  let scene: Scene;
  try {
    const blob = await downloadScene(ws.shareId);
    const json = await decryptScenePayload(ws.encryptionKey, blob);
    scene = { ...emptyScene(), ...JSON.parse(json) };
  } catch (error: any) {
    // If the blob doesn't exist yet (newly created workspace), start empty.
    if (error?.code === 404 || error?.errors?.[0]?.reason === "notFound") {
      scene = emptyScene();
    } else {
      throw error;
    }
  }
  return { scene, shareId: ws.shareId, encryptionKey: ws.encryptionKey };
};

export const saveScene = async (
  workspaceName: string,
  scene: Scene,
  shareId: string,
  encryptionKey: string,
): Promise<void> => {
  const buffer = await encryptScenePayload(
    encryptionKey,
    JSON.stringify(scene),
  );
  await uploadScene(shareId, buffer);
  await touchWorkspace(workspaceName);
};

export const mutateScene = async (
  workspaceName: string,
  mutate: (scene: Scene) => Scene | void,
): Promise<{ elementCount: number }> => {
  const { scene, shareId, encryptionKey } = await loadScene(workspaceName);
  const next = mutate(scene) ?? scene;
  await saveScene(workspaceName, next, shareId, encryptionKey);
  return { elementCount: next.elements.length };
};

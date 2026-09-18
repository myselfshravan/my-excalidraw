// High-level scene mutations: fetch -> decrypt -> mutate -> encrypt -> upload.
// Every scene write pays this full round-trip, which is why the tools batch
// multiple element changes into a single call rather than one call per element.

import { getWorkspace, touchWorkspace } from "./registry.js";
import {
  decryptScenePayload,
  downloadScene,
  encryptScenePayload,
  uploadScene,
  uploadSceneVersion,
} from "./scene.js";
import { commitVersion, getCurrentVersion } from "./versions.js";

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

export const loadScene = async (
  workspaceName: string,
): Promise<{
  scene: Scene;
  shareId: string;
  encryptionKey: string;
  version: number;
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
  const version = await getCurrentVersion(ws.shareId);
  return {
    scene,
    shareId: ws.shareId,
    encryptionKey: ws.encryptionKey,
    version,
  };
};

/**
 * Writes a new version of the scene. `baseVersion` is the version the change
 * was computed from; if anyone has written since, this refuses rather than
 * overwriting their work (see versions.ts for the shared contract).
 *
 * The snapshot blob is uploaded BEFORE the version is committed, so a
 * committed version always has content behind it. A failed commit leaves an
 * unreferenced blob, which is harmless.
 */
export const saveScene = async (
  workspaceName: string,
  scene: Scene,
  shareId: string,
  encryptionKey: string,
  baseVersion: number,
  label?: string,
): Promise<number> => {
  const buffer = await encryptScenePayload(
    encryptionKey,
    JSON.stringify(scene),
  );
  const next = baseVersion + 1;
  // Best-effort, same reasoning as the web app: history is worth less than
  // conflict detection, so a snapshot failure must not block the write.
  try {
    await uploadSceneVersion(shareId, next, buffer);
  } catch (error) {
    console.error("version snapshot upload failed", error);
  }
  const committed = await commitVersion(
    shareId,
    baseVersion,
    "mcp",
    scene.elements.length,
    label,
  );
  // Only now move the pointer the web app loads from.
  await uploadScene(shareId, buffer);
  await touchWorkspace(workspaceName);
  return committed;
};

export const mutateScene = async (
  workspaceName: string,
  mutate: (scene: Scene) => Scene | void,
  label?: string,
): Promise<{ elementCount: number; version: number }> => {
  const { scene, shareId, encryptionKey, version } = await loadScene(
    workspaceName,
  );
  const next = mutate(scene) ?? scene;
  const committed = await saveScene(
    workspaceName,
    next,
    shareId,
    encryptionKey,
    version,
    label,
  );
  return { elementCount: next.elements.length, version: committed };
};

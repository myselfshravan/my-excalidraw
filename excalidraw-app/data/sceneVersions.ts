// Scene version index shared with the MCP server (mcp-server/src/versions.ts).
// Both sides must implement the same contract or concurrent edits silently
// clobber each other:
//
//   Firestore  scene_versions/<shareId>             { version, updatedAt, updatedBy, elementCount }
//              scene_versions/<shareId>/history/<n> { version, createdAt, source, elementCount, label? }
//   Storage    files/shareLinks/<shareId>/versions/<n>  immutable snapshot
//              files/shareLinks/<shareId>/scene         current pointer (kept for existing links)
//
// A write presents the version it was based on. If the stored version has
// moved on, the write is REFUSED rather than applied, so a tab that has been
// open for an hour can never overwrite work done elsewhere in the meantime.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";

import { getAppFirestore } from "./firebase";

export type SceneSource = "app" | "mcp";

const APP_SOURCE: SceneSource = "app";

export type SceneVersionEntry = {
  version: number;
  createdAt: number | null;
  source: SceneSource;
  elementCount: number;
  label?: string;
};

export class SceneVersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `This workspace changed elsewhere (you are on version ${expected}, current is ${actual}).`,
    );
    this.name = "SceneVersionConflictError";
  }
}

const indexDoc = (shareId: string) =>
  doc(getAppFirestore(), "scene_versions", shareId);

export const currentScenePath = (shareId: string) =>
  `files/shareLinks/${shareId}/scene`;

export const sceneVersionPath = (shareId: string, version: number) =>
  `files/shareLinks/${shareId}/versions/${version}`;

export const getCurrentSceneVersion = async (
  shareId: string,
): Promise<number> => {
  try {
    const snap = await getDoc(indexDoc(shareId));
    return snap.exists() ? snap.data()?.version ?? 0 : 0;
  } catch (error) {
    console.warn("scene version lookup failed", error);
    return 0;
  }
};

/**
 * Claims `baseVersion + 1`, refusing if anyone else has written since. The
 * transaction is what makes two writers racing for the same number safe.
 */
export const commitSceneVersion = async (
  shareId: string,
  baseVersion: number,
  elementCount: number,
  label?: string,
): Promise<number> => {
  const ref = indexDoc(shareId);
  const next = baseVersion + 1;
  await runTransaction(getAppFirestore(), async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.data()?.version ?? 0 : 0;
    if (current !== baseVersion) {
      throw new SceneVersionConflictError(baseVersion, current);
    }
    tx.set(
      ref,
      {
        version: next,
        updatedAt: serverTimestamp(),
        updatedBy: APP_SOURCE,
        elementCount,
      },
      { merge: true },
    );
    tx.set(doc(collection(ref, "history"), String(next)), {
      version: next,
      createdAt: serverTimestamp(),
      source: APP_SOURCE,
      elementCount,
      ...(label ? { label } : {}),
    });
  });
  return next;
};

const toMs = (ts: unknown) => (ts instanceof Timestamp ? ts.toMillis() : null);

export const listSceneVersions = async (
  shareId: string,
  max = 50,
): Promise<SceneVersionEntry[]> => {
  const snap = await getDocs(
    query(
      collection(indexDoc(shareId), "history"),
      orderBy("version", "desc"),
      fsLimit(max),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      version: data.version,
      createdAt: toMs(data.createdAt),
      source: (data.source ?? "app") as SceneSource,
      elementCount: data.elementCount ?? 0,
      ...(data.label ? { label: data.label } : {}),
    };
  });
};

/**
 * Notifies when the stored version changes — including writes made by the MCP
 * server — so an open tab can refresh instead of sitting on a stale scene.
 */
export const watchSceneVersion = (
  shareId: string,
  onVersion: (version: number, updatedBy: SceneSource) => void,
): (() => void) =>
  onSnapshot(
    indexDoc(shareId),
    (snap) => {
      if (!snap.exists()) {
        return;
      }
      const data = snap.data();
      onVersion(data.version ?? 0, (data.updatedBy ?? "app") as SceneSource);
    },
    (error) => console.warn("scene version watch failed", error),
  );

/** Seeds the index for a workspace that predates versioning. */
export const ensureSceneVersionSeeded = async (
  shareId: string,
  elementCount: number,
): Promise<number> => {
  const existing = await getCurrentSceneVersion(shareId);
  if (existing > 0) {
    return existing;
  }
  try {
    await setDoc(
      indexDoc(shareId),
      {
        version: 0,
        updatedAt: serverTimestamp(),
        updatedBy: APP_SOURCE,
        elementCount,
      },
      { merge: true },
    );
  } catch (error) {
    console.warn("scene version seed failed", error);
  }
  return 0;
};

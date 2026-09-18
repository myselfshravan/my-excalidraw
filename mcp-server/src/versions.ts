// Scene version index shared with the web app (excalidraw-app/data/sceneVersions.ts).
// Both sides must implement the same contract or concurrent edits silently
// clobber each other:
//
//   Firestore  scene_versions/<shareId>            { version, updatedAt, updatedBy, elementCount }
//              scene_versions/<shareId>/history/<n> { version, createdAt, source, elementCount, label? }
//   Storage    files/shareLinks/<shareId>/versions/<n>   immutable snapshot
//              files/shareLinks/<shareId>/scene          current pointer (kept for existing links)
//
// A write presents the version it was based on. If the stored version has moved
// on, the write is REFUSED rather than applied, so a stale client can never
// overwrite newer work.

import { FieldValue } from "firebase-admin/firestore";

import { db } from "./firebase.js";

export const CURRENT_SCENE_PATH = (shareId: string) =>
  `files/shareLinks/${shareId}/scene`;

export const VERSION_BLOB_PATH = (shareId: string, version: number) =>
  `files/shareLinks/${shareId}/versions/${version}`;

export type SceneSource = "app" | "mcp";

export type VersionEntry = {
  version: number;
  createdAt: number | null;
  source: SceneSource;
  elementCount: number;
  label?: string;
};

export class VersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `Workspace changed since you read it (you based this write on version ${expected}, current is ${actual}). Re-read the workspace and reapply your change.`,
    );
    this.name = "VersionConflictError";
  }
}

const indexDoc = (shareId: string) =>
  db().collection("scene_versions").doc(shareId);

/** Current version, or 0 when the workspace has never been versioned. */
export const getCurrentVersion = async (shareId: string): Promise<number> => {
  const snap = await indexDoc(shareId).get();
  return snap.exists ? snap.data()?.version ?? 0 : 0;
};

/**
 * Claims `baseVersion + 1` for this writer, refusing if anyone else has
 * written since. Runs as a Firestore transaction so two writers racing for the
 * same number cannot both win.
 */
export const commitVersion = async (
  shareId: string,
  baseVersion: number,
  source: SceneSource,
  elementCount: number,
  label?: string,
): Promise<number> => {
  const ref = indexDoc(shareId);
  const next = baseVersion + 1;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data()?.version ?? 0 : 0;
    if (current !== baseVersion) {
      throw new VersionConflictError(baseVersion, current);
    }
    tx.set(
      ref,
      {
        version: next,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: source,
        elementCount,
      },
      { merge: true },
    );
    tx.set(ref.collection("history").doc(String(next)), {
      version: next,
      createdAt: FieldValue.serverTimestamp(),
      source,
      elementCount,
      ...(label ? { label } : {}),
    });
  });
  return next;
};

export const listVersions = async (
  shareId: string,
  limit = 50,
): Promise<VersionEntry[]> => {
  const snap = await indexDoc(shareId)
    .collection("history")
    .orderBy("version", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      version: data.version,
      createdAt: data.createdAt?.toMillis?.() ?? null,
      source: data.source ?? "app",
      elementCount: data.elementCount ?? 0,
      ...(data.label ? { label: data.label } : {}),
    };
  });
};

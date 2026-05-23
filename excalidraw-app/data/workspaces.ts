// Schema + docId derivation must stay compatible with
// mcp-server/src/registry.ts so workspaces created on either side appear on
// both. localStorage caches a per-device recency index for switcher ordering
// and offline fallback.

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";

import { getAppFirestore } from "./firebase";

export type Workspace = {
  docId: string;
  name: string;
  shareId: string;
  encryptionKey: string;
  createdAt: number | null;
  updatedAt: number | null;
};

const COLLECTION = "mcp_workspaces";
const LOCAL_CACHE_KEY = "excalidraw-workspaces:visits:v1";

// Must match mcp-server/src/registry.ts `docId`.
export const workspaceDocId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");

const SHARE_LINK_HASH_RE = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

export const parseShareLinkUrl = (
  url: string,
): { id: string; key: string } | null => {
  try {
    const parsed = new URL(url);
    const match = parsed.hash.match(SHARE_LINK_HASH_RE);
    return match ? { id: match[1], key: match[2] } : null;
  } catch {
    return null;
  }
};

export const buildShareLinkUrl = (id: string, key: string) =>
  `${window.location.origin}${window.location.pathname}#json=${id},${key}`;

const tsToMs = (ts: unknown): number | null => {
  if (ts instanceof Timestamp) {
    return ts.toMillis();
  }
  return null;
};

const snapToWorkspace = (
  snap: { id: string; data: () => any; exists: () => boolean } | {
    id: string;
    data: () => any;
    exists?: never;
  },
): Workspace | null => {
  if ("exists" in snap && typeof snap.exists === "function" && !snap.exists()) {
    return null;
  }
  const data = snap.data();
  if (!data?.shareId || !data?.encryptionKey) {
    return null;
  }
  return {
    docId: snap.id,
    name: data.name ?? snap.id,
    shareId: data.shareId,
    encryptionKey: data.encryptionKey,
    createdAt: tsToMs(data.createdAt),
    updatedAt: tsToMs(data.updatedAt),
  };
};

export const listWorkspaces = async (): Promise<Workspace[]> => {
  const firestore = getAppFirestore();
  const q = query(collection(firestore, COLLECTION), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => snapToWorkspace(d))
    .filter((w): w is Workspace => w !== null);
};

export const getWorkspaceByName = async (
  name: string,
): Promise<Workspace | null> => {
  const firestore = getAppFirestore();
  const snap = await getDoc(doc(firestore, COLLECTION, workspaceDocId(name)));
  return snapToWorkspace(snap);
};

export const getWorkspaceByShareId = async (
  shareId: string,
): Promise<Workspace | null> => {
  // Scan-based; if the registry grows hot, add a where("shareId", "==", ...) index.
  const all = await listWorkspaces();
  return all.find((w) => w.shareId === shareId) ?? null;
};

export const registerWorkspace = async (params: {
  name: string;
  shareId: string;
  encryptionKey: string;
}): Promise<Workspace> => {
  const firestore = getAppFirestore();
  const docId = workspaceDocId(params.name);
  const ref = doc(firestore, COLLECTION, docId);
  const existing = await getDoc(ref);
  await setDoc(
    ref,
    {
      name: params.name,
      shareId: params.shareId,
      encryptionKey: params.encryptionKey,
      ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  const fresh = await getDoc(ref);
  const result = snapToWorkspace(fresh);
  if (!result) {
    throw new Error("registerWorkspace: failed to read back document");
  }
  recordLocalVisit(docId);
  return result;
};

export const renameWorkspace = async (
  currentName: string,
  newName: string,
  fields: { shareId: string; encryptionKey: string },
): Promise<Workspace> => {
  const firestore = getAppFirestore();
  const oldDocId = workspaceDocId(currentName);
  const newDocId = workspaceDocId(newName);
  const newRef = doc(firestore, COLLECTION, newDocId);
  await setDoc(newRef, {
    name: newName,
    shareId: fields.shareId,
    encryptionKey: fields.encryptionKey,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if (oldDocId !== newDocId) {
    await deleteDoc(doc(firestore, COLLECTION, oldDocId));
    forgetLocalVisit(oldDocId);
  }
  const fresh = await getDoc(newRef);
  const result = snapToWorkspace(fresh);
  if (!result) {
    throw new Error("renameWorkspace: failed to read back document");
  }
  recordLocalVisit(newDocId);
  return result;
};

export const removeWorkspace = async (docId: string): Promise<void> => {
  const firestore = getAppFirestore();
  await deleteDoc(doc(firestore, COLLECTION, docId));
  forgetLocalVisit(docId);
};

export const touchWorkspace = async (docId: string): Promise<void> => {
  const firestore = getAppFirestore();
  await setDoc(
    doc(firestore, COLLECTION, docId),
    { updatedAt: serverTimestamp() },
    { merge: true },
  );
};

type LocalCache = Record<string, { lastOpenedAt: number }>;

const readLocalCache = (): LocalCache => {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

const writeLocalCache = (cache: LocalCache) => {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // private mode / quota exceeded — non-fatal.
  }
};

export const recordLocalVisit = (docId: string) => {
  const cache = readLocalCache();
  cache[docId] = { lastOpenedAt: Date.now() };
  writeLocalCache(cache);
};

export const forgetLocalVisit = (docId: string) => {
  const cache = readLocalCache();
  delete cache[docId];
  writeLocalCache(cache);
};

export const getLocalVisitedDocIds = (): string[] => {
  const cache = readLocalCache();
  return Object.entries(cache)
    .sort((a, b) => b[1].lastOpenedAt - a[1].lastOpenedAt)
    .map(([docId]) => docId);
};

// Lists from Firestore, reordered so this-device recents float to the top.
// Falls back to per-id gets from local cache if Firestore is unreachable.
export const listWorkspacesWithLocalOrder = async (): Promise<Workspace[]> => {
  try {
    const remote = await listWorkspaces();
    const localOrder = new Map(
      getLocalVisitedDocIds().map((id, idx) => [id, idx]),
    );
    return remote.slice().sort((a, b) => {
      const aLocal = localOrder.get(a.docId);
      const bLocal = localOrder.get(b.docId);
      if (aLocal !== undefined && bLocal !== undefined) {
        return aLocal - bLocal;
      }
      if (aLocal !== undefined) {
        return -1;
      }
      if (bLocal !== undefined) {
        return 1;
      }
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  } catch {
    // Firestore unreachable — fall back to per-id gets from local cache.
    const ids = getLocalVisitedDocIds();
    const firestore = getAppFirestore();
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return snapToWorkspace(
            await getDoc(doc(firestore, COLLECTION, id)),
          );
        } catch {
          return null;
        }
      }),
    );
    return results.filter((w): w is Workspace => w !== null);
  }
};

// Idempotent: bumps updatedAt if a doc already points at this shareId,
// otherwise creates one with a default name derived from shareId.
export const ensureWorkspaceRegistered = async (
  shareId: string,
  encryptionKey: string,
  defaultName?: string,
): Promise<Workspace> => {
  const existing = await getWorkspaceByShareId(shareId);
  if (existing) {
    await touchWorkspace(existing.docId);
    recordLocalVisit(existing.docId);
    return { ...existing, updatedAt: Date.now() };
  }
  const name = defaultName ?? `shared-${shareId}`;
  return registerWorkspace({ name, shareId, encryptionKey });
};

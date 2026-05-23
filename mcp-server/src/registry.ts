import { FieldValue } from "firebase-admin/firestore";

import { db } from "./firebase.js";

export type WorkspaceEntry = {
  name: string;
  shareId: string;
  encryptionKey: string;
  createdAt: number | null;
  updatedAt: number | null;
};

const collection = () => db.collection("mcp_workspaces");

const docId = (name: string) => name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");

export const parseShareLink = (
  url: string,
): { id: string; key: string } | null => {
  try {
    const parsed = new URL(url);
    const match = parsed.hash.match(
      /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
    );
    if (!match) {
      return null;
    }
    return { id: match[1], key: match[2] };
  } catch {
    return null;
  }
};

export const registerWorkspace = async (
  name: string,
  shareId: string,
  encryptionKey: string,
): Promise<WorkspaceEntry> => {
  const id = docId(name);
  await collection().doc(id).set(
    {
      name,
      shareId,
      encryptionKey,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const snap = await collection().doc(id).get();
  return readEntry(snap)!;
};

export const listWorkspaces = async (): Promise<WorkspaceEntry[]> => {
  const snap = await collection().orderBy("updatedAt", "desc").get();
  return snap.docs.map((d) => readEntry(d)!).filter(Boolean);
};

export const getWorkspace = async (
  name: string,
): Promise<WorkspaceEntry | null> => {
  const snap = await collection().doc(docId(name)).get();
  return readEntry(snap);
};

export const deleteWorkspace = async (name: string): Promise<void> => {
  await collection().doc(docId(name)).delete();
};

export const renameWorkspace = async (
  currentName: string,
  newName: string,
  fields: { shareId: string; encryptionKey: string },
): Promise<WorkspaceEntry> => {
  // Doc IDs are derived from the name — moving the entry requires write-new
  // then delete-old.
  const newDocId = docId(newName);
  await collection().doc(newDocId).set({
    name: newName,
    shareId: fields.shareId,
    encryptionKey: fields.encryptionKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (docId(currentName) !== newDocId) {
    await collection().doc(docId(currentName)).delete();
  }
  const snap = await collection().doc(newDocId).get();
  return readEntry(snap)!;
};

export const touchWorkspace = async (name: string): Promise<void> => {
  await collection().doc(docId(name)).update({
    updatedAt: FieldValue.serverTimestamp(),
  });
};

const readEntry = (
  snap: FirebaseFirestore.DocumentSnapshot,
): WorkspaceEntry | null => {
  if (!snap.exists) {
    return null;
  }
  const data = snap.data()!;
  return {
    name: data.name,
    shareId: data.shareId,
    encryptionKey: data.encryptionKey,
    createdAt: data.createdAt?.toMillis?.() ?? null,
    updatedAt: data.updatedAt?.toMillis?.() ?? null,
  };
};

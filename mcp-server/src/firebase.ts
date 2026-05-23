import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import fs from "node:fs";
import path from "node:path";

const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
if (!storageBucket) {
  throw new Error(
    "FIREBASE_STORAGE_BUCKET env var is required (e.g. my-excalidraw-70bab.firebasestorage.app).",
  );
}

const loadServiceAccount = (): Record<string, unknown> => {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    return JSON.parse(inline);
  }
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  }
  throw new Error(
    "Set FIREBASE_SERVICE_ACCOUNT_JSON (preferred for hosted) or FIREBASE_SERVICE_ACCOUNT_PATH (for local stdio).",
  );
};

// Guard against re-initialization in long-lived environments (serverless warm
// invocations reuse the module).
if (getApps().length === 0) {
  initializeApp({
    credential: cert(loadServiceAccount() as Parameters<typeof cert>[0]),
    storageBucket,
  });
}

export const db = getFirestore();
export const bucket = getStorage().bucket();

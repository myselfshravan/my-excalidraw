import fs from "node:fs";

import path from "node:path";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const loadServiceAccount = (): Record<string, unknown> => {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error: any) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`,
      );
    }
  }
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_PATH points at a missing file: ${resolved}`,
      );
    }
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  }
  throw new Error(
    "No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON (preferred for hosted) or FIREBASE_SERVICE_ACCOUNT_PATH (for local stdio).",
  );
};

// Initialization is deferred until the first tool call that actually needs
// Firebase. Doing it at import time meant a missing env var threw before the
// stdio transport was connected, so the client saw an opaque "server exited"
// instead of the message explaining which variable to set.
let app: ReturnType<typeof initializeApp> | undefined;

const ensureApp = () => {
  if (app) {
    return app;
  }
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!storageBucket) {
    throw new Error(
      "FIREBASE_STORAGE_BUCKET env var is required (e.g. my-excalidraw-70bab.firebasestorage.app).",
    );
  }
  // Reuse an app another module already created (serverless warm invocations).
  const existing = getApps();
  app =
    existing.length > 0
      ? existing[0]
      : initializeApp({
          credential: cert(loadServiceAccount() as Parameters<typeof cert>[0]),
          storageBucket,
        });
  return app;
};

// Return types are inferred: annotating them pulls @google-cloud/storage's ESM
// declarations while firebase-admin resolves the CJS ones, and the two Bucket
// types are structurally incompatible.
export const db = () => getFirestore(ensureApp());
export const bucket = () => getStorage(ensureApp()).bucket();

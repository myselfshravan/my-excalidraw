import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import fs from "node:fs";
import path from "node:path";

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

if (!serviceAccountPath) {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT_PATH env var is required (path to a Firebase service account JSON file).",
  );
}
if (!storageBucket) {
  throw new Error(
    "FIREBASE_STORAGE_BUCKET env var is required (e.g. my-excalidraw-70bab.firebasestorage.app).",
  );
}

const serviceAccount = JSON.parse(
  fs.readFileSync(path.resolve(serviceAccountPath), "utf8"),
);

initializeApp({
  credential: cert(serviceAccount),
  storageBucket,
});

export const db = getFirestore();
export const bucket = getStorage().bucket();

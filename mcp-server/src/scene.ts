// Port of packages/excalidraw/data/{encode,encryption}.ts so the MCP server
// can read and write the same wire format the Excalidraw web app uses for
// share-link blobs in Firebase Storage. AES-GCM via Node Web Crypto + pako
// deflate, framed by [version, length-prefixed chunks].

import { deflate, inflate } from "pako";

import { bucket } from "./firebase.js";

const VERSION_BYTES = 4;
const CHUNK_LEN_BYTES = 4;
const CONCAT_VERSION = 1;
const IV_LENGTH_BYTES = 12;

const concatBuffers = (...buffers: Uint8Array[]): Uint8Array => {
  const total =
    VERSION_BYTES +
    CHUNK_LEN_BYTES * buffers.length +
    buffers.reduce((acc, b) => acc + b.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;
  view.setUint32(cursor, CONCAT_VERSION);
  cursor += VERSION_BYTES;
  for (const buf of buffers) {
    view.setUint32(cursor, buf.byteLength);
    cursor += CHUNK_LEN_BYTES;
    out.set(buf, cursor);
    cursor += buf.byteLength;
  }
  return out;
};

const splitBuffers = (input: Uint8Array): Uint8Array<ArrayBuffer>[] => {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = view.getUint32(0);
  if (version > CONCAT_VERSION) {
    throw new Error(`unsupported concat-buffer version ${version}`);
  }
  let cursor = VERSION_BYTES;
  const out: Uint8Array<ArrayBuffer>[] = [];
  while (cursor < input.byteLength) {
    const len = view.getUint32(cursor);
    cursor += CHUNK_LEN_BYTES;
    const chunk = new Uint8Array(len);
    chunk.set(input.subarray(cursor, cursor + len));
    out.push(chunk);
    cursor += len;
  }
  return out;
};

const importKey = (key: string, usage: KeyUsage): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: key,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    { name: "AES-GCM", length: 128 },
    false,
    [usage],
  );

export const encryptScenePayload = async (
  encryptionKey: string,
  sceneJSON: string,
): Promise<Uint8Array> => {
  const fileInfo = {
    version: 2,
    compression: "pako@1",
    encryption: "AES-GCM",
  };
  const encodingMetadataBuffer = new TextEncoder().encode(
    JSON.stringify(fileInfo),
  );
  const contentsMetadataBuffer = new TextEncoder().encode(
    JSON.stringify(null),
  );
  const dataBuffer = new TextEncoder().encode(sceneJSON);

  const innerConcat = concatBuffers(contentsMetadataBuffer, dataBuffer);
  const deflated = deflate(innerConcat);

  const iv = globalThis.crypto.getRandomValues(
    new Uint8Array(IV_LENGTH_BYTES),
  );
  const key = await importKey(encryptionKey, "encrypt");
  const encrypted = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      deflated,
    ),
  );

  return concatBuffers(encodingMetadataBuffer, iv, encrypted);
};

export const decryptScenePayload = async (
  decryptionKey: string,
  buffer: Uint8Array,
): Promise<string> => {
  const [encodingMetadataBuffer, iv, ciphertext] = splitBuffers(buffer);
  // encoding metadata may inform pako/aes choices; we currently only support
  // pako@1 + AES-GCM (same as the app). If we ever change this, branch here.
  void encodingMetadataBuffer;

  const key = await importKey(decryptionKey, "decrypt");
  const decrypted = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    ),
  );
  const inflated = inflate(decrypted);
  const [_contentsMetadataBuffer, contentsBuffer] = splitBuffers(inflated);
  return new TextDecoder().decode(contentsBuffer);
};

const sceneStoragePath = (id: string) => `files/shareLinks/${id}/scene`;

export const downloadScene = async (id: string): Promise<Uint8Array> => {
  const [data] = await bucket.file(sceneStoragePath(id)).download();
  return new Uint8Array(data);
};

export const uploadScene = async (
  id: string,
  buffer: Uint8Array,
): Promise<void> => {
  await bucket.file(sceneStoragePath(id)).save(Buffer.from(buffer), {
    contentType: "application/octet-stream",
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });
};

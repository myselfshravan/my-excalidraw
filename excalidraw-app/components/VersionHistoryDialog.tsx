import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import React, { useEffect, useState } from "react";

import {
  listSceneVersions,
  type SceneVersionEntry,
} from "../data/sceneVersions";

import "./VersionHistoryDialog.scss";

const relativeTime = (ms: number | null) => {
  if (!ms) {
    return "just now";
  }
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(ms).toLocaleString();
};

/**
 * Every write from the app or the MCP server commits a snapshot, so this is
 * the full edit history for a workspace. Restoring is non-destructive: it
 * commits the old content as a new version, so the restore is itself undoable.
 */
export const VersionHistoryDialog: React.FC<{
  shareId: string;
  currentVersion: number;
  onRestore: (version: number) => Promise<void>;
  onClose: () => void;
}> = ({ shareId, currentVersion, onRestore, onClose }) => {
  const [versions, setVersions] = useState<SceneVersionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSceneVersions(shareId)
      .then((list) => {
        if (!cancelled) {
          setVersions(list);
        }
      })
      .catch((err) => {
        console.warn("failed to list versions", err);
        if (!cancelled) {
          setError("Couldn't load version history.");
          setVersions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shareId, currentVersion]);

  const restore = async (version: number) => {
    setRestoring(version);
    try {
      await onRestore(version);
      onClose();
    } catch (err) {
      console.error(err);
      setError("Restore failed.");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog onCloseRequest={onClose} title="Version history" size="small">
      <div className="VersionHistory">
        {versions === null && <p className="VersionHistory__empty">Loading…</p>}
        {error && <p className="VersionHistory__error">{error}</p>}
        {versions?.length === 0 && !error && (
          <p className="VersionHistory__empty">
            No saved versions yet. Edits from now on will appear here.
          </p>
        )}
        {versions?.map((entry) => {
          const isCurrent = entry.version === currentVersion;
          return (
            <div
              key={entry.version}
              className={`VersionHistory__row${
                isCurrent ? " VersionHistory__row--current" : ""
              }`}
            >
              <div className="VersionHistory__meta">
                <span className="VersionHistory__title">
                  v{entry.version}
                  {isCurrent && (
                    <span className="VersionHistory__badge">current</span>
                  )}
                  <span
                    className={`VersionHistory__source VersionHistory__source--${entry.source}`}
                  >
                    {entry.source === "mcp" ? "Claude" : "Browser"}
                  </span>
                </span>
                <span className="VersionHistory__sub">
                  {relativeTime(entry.createdAt)} · {entry.elementCount} element
                  {entry.elementCount === 1 ? "" : "s"}
                  {entry.label ? ` · ${entry.label}` : ""}
                </span>
              </div>
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => restore(entry.version)}
                  disabled={restoring !== null}
                >
                  {restoring === entry.version ? "Restoring…" : "Restore"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
};

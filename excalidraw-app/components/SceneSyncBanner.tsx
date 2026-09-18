import React from "react";

import "./SceneSyncBanner.scss";

/**
 * Shown only when this tab has unsaved edits AND the workspace changed
 * elsewhere (another tab, or an MCP write). Both sides are still intact at
 * this point — the local edits are on canvas, the remote version is in
 * storage — so the user picks which one survives instead of one silently
 * overwriting the other.
 */
export const SceneSyncBanner: React.FC<{
  version: number;
  updatedBy: "app" | "mcp";
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
}> = ({ version, updatedBy, busy, onReload, onOverwrite, onDismiss }) => (
  <div className="SceneSyncBanner" role="alert">
    <div className="SceneSyncBanner__text">
      <strong>Updated elsewhere</strong>
      <span>
        {updatedBy === "mcp" ? "Claude (MCP)" : "Another tab"} saved version{" "}
        {version}. You have unsaved changes here.
      </span>
    </div>
    <div className="SceneSyncBanner__actions">
      <button type="button" onClick={onReload} disabled={busy}>
        Load theirs
      </button>
      <button type="button" onClick={onOverwrite} disabled={busy}>
        Keep mine
      </button>
      <button
        type="button"
        className="SceneSyncBanner__dismiss"
        onClick={onDismiss}
        disabled={busy}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  </div>
);

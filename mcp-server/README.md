# my-excalidraw-mcp

An MCP server that reads and writes Excalidraw workspaces in your self-hosted deployment. A "workspace" is a regular Excalidraw share link (`#json=<id>,<key>`) registered under a friendly name in a Firestore `mcp_workspaces` collection.

Tools exposed:

- `list_workspaces` — list registered workspaces
- `register_workspace(name, share_link_url)` — bind a friendly name to a share link
- `read_workspace(name)` — fetch + decrypt the current scene, return elements + appState
- `update_workspace(name, elements, appState?)` — encrypt + upload a new scene (replaces existing)
- `delete_workspace(name)` — forget the friendly name (keeps the Storage blob)

## Setup

### 1. Create a Firebase service account

In Firebase Console → ⚙️ Project Settings → **Service accounts** tab → click **Generate new private key** → save the JSON file somewhere safe **outside this repo** (e.g. `~/.config/my-excalidraw-mcp/service-account.json`). This file grants full admin access to the Firebase project — never commit it.

### 2. Install + build

```bash
cd mcp-server
npm install
npm run build
```

### 3. Wire it into Claude Code

Add to `~/.claude/mcp.json` (or your client's MCP config):

```json
{
  "mcpServers": {
    "my-excalidraw": {
      "command": "node",
      "args": ["/absolute/path/to/my-excalidraw/mcp-server/build/index.js"],
      "env": {
        "FIREBASE_SERVICE_ACCOUNT_PATH": "/absolute/path/to/service-account.json",
        "FIREBASE_STORAGE_BUCKET": "my-excalidraw-70bab.firebasestorage.app",
        "EXCALIDRAW_APP_URL": "https://my-excalidraw-six.vercel.app"
      }
    }
  }
}
```

Restart your MCP client. The tools should appear.

## Usage flow

1. Open your Excalidraw deployment, draw a scene, click **Export to Link**. Copy the URL.
2. In your MCP client (Claude Code, etc): _"Register that URL as workspace 'arch-diagrams'."_ — it calls `register_workspace`.
3. _"Show me what's in arch-diagrams."_ — calls `read_workspace`, returns elements.
4. _"Add a red rectangle to arch-diagrams."_ — calls `update_workspace` with the modified elements array.
5. Refresh the share link in your browser — your edits are there (because the app auto-saves and the MCP server writes to the same Firebase Storage path).

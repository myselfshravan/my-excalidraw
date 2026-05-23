# my-excalidraw-mcp

An MCP server that reads and writes Excalidraw workspaces in your self-hosted deployment. A "workspace" is a regular Excalidraw share link (`#json=<id>,<key>`) tracked under a friendly name in a Firestore `mcp_workspaces` collection.

Read/write goes through the Firebase Admin SDK directly to the same encrypted scene blobs the web app reads, so edits made via MCP show up live when you refresh the share link in your browser.

## Tools

### Workspace registry

| Tool | Purpose |
|---|---|
| `list_workspaces` | List all registered workspaces |
| `register_workspace(name, share_link_url)` | Bind a friendly name to an existing share link |
| `create_workspace(name)` | Mint a brand-new empty workspace (no need to start in the browser) |
| `rename_workspace(current_name, new_name)` | Update friendly name |
| `delete_workspace(name)` | Remove from registry (Storage blob stays) |

### Scene read/write

| Tool | Purpose |
|---|---|
| `read_workspace(name)` | Fetch + decrypt scene, return elements + appState |
| `replace_workspace(name, elements, appState?)` | Replace the entire scene |
| `clear_workspace(name)` | Remove all elements (keeps workspace registered) |
| `delete_elements(name, element_ids)` | Remove specific elements by id |

### Element helpers (high-level builders)

All append to the workspace's scene, returning the new element's `id`.

| Tool | Args |
|---|---|
| `add_rectangle(name, x, y, width, height, …style)` | Returns id |
| `add_ellipse(name, x, y, width, height, …style)` | Returns id |
| `add_diamond(name, x, y, width, height, …style)` | Returns id |
| `add_text(name, x, y, text_content, fontSize?, fontFamily?, …)` | Returns id |
| `add_arrow(name, from, to, startArrowhead?, endArrowhead?, …)` | Returns id. `from`/`to` can be `{x,y}` coords OR `{elementId}` for bindings |
| `add_line(name, points)` | Returns id |

Style fields available on most helpers: `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth` (1/2/4), `strokeStyle` (solid/dashed/dotted), `roughness` (0/1/2), `opacity`, `angle`.

## Setup (local stdio)

### 1. Create a Firebase service account

Firebase Console → ⚙️ **Project Settings** → **Service accounts** → **Generate new private key**. Save the JSON file outside this repo, e.g. `~/.config/my-excalidraw-mcp/service-account.json`. **Never commit it.**

### 2. Install + build

```bash
cd mcp-server
npm install
npm run build
```

### 3. Wire it into Claude Code

Add to `~/.claude/mcp.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "my-excalidraw": {
      "command": "node",
      "args": ["/Users/shravan/personal-github/my-excalidraw/mcp-server/build/index.js"],
      "env": {
        "FIREBASE_SERVICE_ACCOUNT_PATH": "/Users/shravan/.config/my-excalidraw-mcp/service-account.json",
        "FIREBASE_STORAGE_BUCKET": "my-excalidraw-70bab.firebasestorage.app",
        "EXCALIDRAW_APP_URL": "https://my-excalidraw-six.vercel.app"
      }
    }
  }
}
```

Restart Claude Code. The tools should appear.

### 4. Test flow

In Claude Code:

1. _"Create an Excalidraw workspace called 'flow-test'."_ — calls `create_workspace`, returns a URL.
2. Open the URL in your browser — should load an empty canvas.
3. _"In 'flow-test', add a rectangle at 100,100 width 200 height 80 with a red stroke, then add the text 'Hello' centered inside it."_ — calls `add_rectangle` + `add_text`.
4. Refresh the browser tab — your shapes should be there.
5. _"Read what's in 'flow-test' now."_ — calls `read_workspace`, returns elements.

## Roadmap

- **Next**: HTTP transport on Vercel Functions with bearer-token auth, so the MCP runs serverless and your Claude config is just URL + token (no local process, no service-account JSON on disk).

## Notes

- The `register_workspace` / `read_workspace` / writes all use the **same encryption key** that's in the share link's URL fragment. The MCP server stores the key in Firestore (`mcp_workspaces` collection); since you control the Firebase project, that's effectively the same trust level as the web app's local-storage cache.
- Add a budget alert in Firebase Console → Usage and billing → Details and settings. Personal usage stays well within free quotas, but the alert is cheap insurance.

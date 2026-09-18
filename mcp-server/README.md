# my-excalidraw-mcp

An MCP server that reads and writes Excalidraw workspaces in your self-hosted deployment. A "workspace" is a regular Excalidraw share link (`#json=<id>,<key>`) tracked under a friendly name in a Firestore `mcp_workspaces` collection.

Read/write goes through the Firebase Admin SDK directly to the same encrypted scene blobs the web app reads, so edits made via MCP show up live when you refresh the share link in your browser.

## Tools

### Workspace registry

| Tool | Purpose |
| --- | --- |
| `list_workspaces` | List all registered workspaces |
| `register_workspace(name, share_link_url)` | Bind a friendly name to an existing share link |
| `create_workspace(name)` | Mint a brand-new empty workspace (no need to start in the browser) |
| `rename_workspace(current_name, new_name)` | Update friendly name |
| `delete_workspace(name)` | Remove from registry (Storage blob stays) |

### Scene read/write

| Tool | Purpose |
| --- | --- |
| `read_workspace(name, mode?)` | Fetch + decrypt the scene. `mode="summary"` (default) returns one compact line per element plus per-type counts; `mode="full"` returns the raw elements array + appState |
| `add_elements(name, elements)` | Append one or more elements in a single round-trip |
| `update_elements(name, updates)` | Change existing elements in place by id — move, resize, restyle, edit text |
| `replace_workspace(name, elements, appState?)` | Replace the entire scene |
| `clear_workspace(name)` | Remove all elements (keeps workspace registered) |
| `delete_elements(name, element_ids)` | Remove specific elements by id, scrubbing any bindings that pointed at them |

### Building a diagram with `add_elements`

Every scene write is a full download → decrypt → mutate → encrypt → upload round-trip, so one call per element is both slow and unsafe: concurrent calls each read the same starting scene and the last upload wins, silently dropping the others. `add_elements` takes the whole batch instead.

Give an element a `ref` and any _later_ element in the same call can use it as an arrow endpoint, so shapes and the arrows between them are created together without a second call to learn the generated ids:

```json
{
  "name": "flow-test",
  "elements": [
    {
      "type": "rectangle",
      "ref": "a",
      "x": 0,
      "y": 0,
      "width": 120,
      "height": 60
    },
    {
      "type": "rectangle",
      "ref": "b",
      "x": 300,
      "y": 0,
      "width": 120,
      "height": 60
    },
    { "type": "arrow", "from": { "ref": "a" }, "to": { "ref": "b" } }
  ]
}
```

Element types: `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`.

Arrow endpoints accept `{x, y}` raw coordinates, `{elementId}` for an element already in the scene, or `{ref}` for one created earlier in the same call. A bound endpoint anchors to the shape's _edge_ (plus a small gap) rather than its centre, and the arrow is recorded in the shape's `boundElements` so dragging the shape moves the arrow with it.

Line `points` are given as absolute canvas coordinates; the first point becomes the element's origin and the rest are stored relative to it, as Excalidraw expects.

Style fields available on every element: `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth` (1/2/4), `strokeStyle` (solid/dashed/dotted), `roughness` (0/1/2), `opacity`, `angle`.

### Editing what is already there

`update_elements` patches elements by id, so there is no need to read a whole scene and push it back with `replace_workspace`:

```json
{
  "name": "flow-test",
  "updates": [
    { "id": "…", "dx": 40, "dy": 0 },
    { "id": "…", "text": "Renamed", "strokeColor": "#e03131" }
  ]
}
```

`x`/`y` set an absolute position, `dx`/`dy` shift by a delta. Moving or resizing a shape re-routes any arrow bound to it, so the arrow still meets the shape's edge (Excalidraw only does this during interactive drags, not for a scene loaded from JSON). Text elements are re-measured when their `text` or `fontSize` changes and no explicit `width`/`height` is given. If any id in the batch is unknown, nothing is written.

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
      "args": [
        "/Users/shravan/personal-github/my-excalidraw/mcp-server/build/index.js"
      ],
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
3. _"In 'flow-test', add a rectangle at 100,100 width 200 height 80 with a red stroke and the text 'Hello' inside it."_ — one `add_elements` call.
4. Refresh the browser tab — your shapes should be there.
5. _"Read what's in 'flow-test' now."_ — calls `read_workspace`, returning the compact summary.
6. _"Move that rectangle 50px right."_ — calls `update_elements` with a `dx`.

## Roadmap

- **Next**: HTTP transport on Vercel Functions with bearer-token auth, so the MCP runs serverless and your Claude config is just URL + token (no local process, no service-account JSON on disk).

## Notes

- The `register_workspace` / `read_workspace` / writes all use the **same encryption key** that's in the share link's URL fragment. The MCP server stores the key in Firestore (`mcp_workspaces` collection); since you control the Firebase project, that's effectively the same trust level as the web app's local-storage cache.
- Add a budget alert in Firebase Console → Usage and billing → Details and settings. Personal usage stays well within free quotas, but the alert is cheap insurance.

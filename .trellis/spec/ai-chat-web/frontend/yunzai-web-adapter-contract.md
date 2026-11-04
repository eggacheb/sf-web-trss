# Yunzai Web Adapter Contract

## Scenario: Single-user private Web adapter

### 1. Scope / Trigger
- Trigger: A WebSocket plugin replaces a chat adapter entry point and injects browser messages into Yunzai's private message event flow. Browser UI deployment is owned by the standalone static frontend repository, not by the adapter plugin directory.
- Applies to `sf-web-adapter/` and similar Yunzai plugins that expose `apps/*.js` management commands.

### 2. Signatures
- Plugin app export: `export { apps }` from `index.js`.
- App loader: load every `apps/*.js` module and map each file stem to its first exported class.
- Adapter export/lifecycle: `index.js` must export `adapter`, push it with `Bot.adapter.push(adapter)`, and implement an idempotent `adapter.load()` method because TRSS-Yunzai's listener loader calls `await adapter.load()` for every registered adapter.
- Plugin root path: follow the `TRSS-WeChat-OC-Plugin` pattern in `model/path.js`: derive `_path` from `process.cwd()`, derive `pluginName` from `import.meta.url`, and set `pluginRoot = path.join(_path, "plugins", pluginName)`. This adapter is expected to run from a TRSS-Yunzai `plugins/sf-web-adapter` install.
- WebSocket input: `{ type: "auth" | "loadHistory" | "message" | "clearHistory" | "getMedia", ... }`.
- Frontend WebSocket URL resolver: direct `ws://host:port` by default. An `https:` page cannot open a plaintext `ws://` (mixed content); either allow insecure content for that origin in the browser, or set `WS_DIRECT_URL` in `js/app.js` to a `wss://` reverse proxy. Do not reintroduce the removed third-party Deno proxy.
- Static frontend ownership: `sf-web-adapter/` no longer owns a `web/public/` browser UI tree. Static UI files belong in the standalone `sf-web-trss-web` repository root. Do not reintroduce copied frontend build output into `sf-web-adapter/`; deploy the frontend independently and connect it to the adapter's `ws://host:port` endpoint.
- Adapter HTTP server: keep the HTTP server only as the WebSocket same-port carrier. `/` or `/index.html` may return a plain endpoint message, but it must not read from `web/public/` or serve copied frontend assets.
- Yunzai event: `Bot.em("message.private", e)`.
- Reply path: `adapter.sendFriendMsg(data, msg)`.
- Friend picker: `adapter.pickFriend(data, user_id)` / `Bot[botId].pickFriend(user_id)` must return the friend sendable object synchronously. Its `sendMsg` method may return a Promise, but `pickFriend(...).sendMsg(...)` must be chain-callable without `await`.
- Redis key: `sf_web_adapter:history:{userQQ}`.
- Server-owned history: Redis is the single source of truth for chat history. The frontend must not persist messages or media in IndexedDB, localStorage, or any other browser store. It may keep fetched media data URLs only in memory for the current page session.
- Media store: `plugins/sf-web-adapter/data/media/<userQQ>/<sha1-prefix>.<ext>`, addressed by `media:<id>` references inside history `content`.

### 3. Contracts
- `auth` request: `{ password?: string }`; response: `{ type: "auth", success: boolean, message?: string }`.
- `loadHistory` request: `{ type: "loadHistory", userQQ: string, before?: string, limit?: number }`; response: `{ type: "history", messages: Array<HistoryEntry>, hasMore: boolean }`. `before` is a message `id` (return only earlier entries); `limit` unset or 0 returns all entries bounded by `history_max`.
- History entry: `{ id: string, role: "user" | "bot", content: string, medias?: Array<{ kind: "image" | "record", id: string, mime: string, pos: number }>, timestamp: number }`. `content` keeps the original markdown. Media positions are `![图片](media:<id>)` or `<audio controls src="media:<id>"></audio>`; base64 never goes into Redis.
- `message` request: `{ type: "message", content?: string, images?: string[], userQQ: string, timestamp?: number }`.
- `clearHistory` request: `{ type: "clearHistory", userQQ: string }`; response `{ type: "historyCleared" }` is broadcast to the active socket. It deletes the Redis key **and** the user's media directory.
- `getMedia` request: `{ type: "getMedia", userQQ: string, id: string }`; response `{ type: "media", id, mime, dataUrl }`, or `{ type: "mediaMissing", id }` for an invalid/expired id.
- Server-owned history contract: both inbound user images and outbound bot image/record segments are written to `data/media/<userQQ>/`. The frontend renders every `history` entry immediately (an unresolved media becomes a `[图片]` / `[语音]` placeholder), then requests each `id` via `getMedia` and refreshes only the entries referencing that `id`. No content fingerprinting, no position guessing, no local replay cache.
- Clear contract: the frontend "清空对话记录" button sends `clearHistory`; `#web清空记录` uses the same server-side clear helper and also broadcasts `historyCleared`. The frontend "清空页面" button clears only the DOM and must not send `clearHistory`.
- Single-active WebSocket: after a WebSocket authenticates, it becomes the only active connection for `loadHistory`, `message`, `clearHistory` and `getMedia`. Older authenticated sockets may remain open, but they must not inject messages into Yunzai or mutate Redis history.
- Connection lifecycle: when the frontend opens a new socket it must detach the previous socket's `onopen`/`onclose`/`onerror`/`onmessage` handlers, and every handler must verify it still owns `AppState.wsConnection`. Otherwise a late `onclose` clears `wsAuthenticated` and silently skips `requestHistory()`.
- Yunzai event fields must include `bot`, `self_id`, `post_type: "message"`, `message_type: "private"`, `user_id: "web_${userQQ}"`, `sender`, `message`, `raw_message`, `original_message`, and `original_raw_message`.
- Outbound image/record segments may use `Buffer`, `base64://`, `data:*;base64`, `file://`, local file paths, or `http(s)://`. Live WebSocket payloads keep full data URLs; the Redis copy replaces them with `media:<id>` references while the bytes are written to disk. Concurrent writes of the same content hash must be coalesced: two simultaneous `writeFile` calls to one path fail with `EPERM` on Windows.
- Extra package dependencies are limited to `ws`; do not introduce utility dependencies such as `lodash` for simple config assignment.

### 4. Validation & Error Matrix
- Missing or failed authentication -> `{ type: "error", content: "请先进行密码认证" }`.
- Invalid JSON -> `{ type: "error", content: "无效的 JSON 格式" }`.
- Unknown WebSocket `type` -> `{ type: "error", content: "未知消息类型" }`.
- Authenticated but inactive WebSocket -> `{ type: "error", content: "当前连接已被新的 Web 会话接管，请重新连接" }`.
- Invalid image base64 -> `{ type: "error", content: "图片数据格式无效" }`.
- Image over configured byte limit -> `{ type: "error", content: "图片过大..." }`.
- History load parse/storage failure -> `{ type: "error", content: "加载历史失败" }`.
- Corrupt single Redis history entries -> skip the bad item, log it, and continue returning valid history entries.
- Outbound media conversion failure -> send `[图片]` or `[语音]` placeholder instead of throwing out of `sendFriendMsg()`.
- `getMedia` miss, timeout, or expired file -> keep `[图片]` / `[语音]` in that one message; never block or clear the rest of the history, and never throw from message rendering.
- Media write failure -> log a warning and fall back to a plain placeholder in the stored history entry; the live reply is unaffected.

### 5. Good/Base/Bad Cases
- Good: `apps/WebManagement.js` defines commands and `index.js` exports an `apps` object, so `#web状态`, `#web重启`, and `#web清空记录` are registered.
- Good: `index.js` follows the `TRSS-WeChat-OC-Plugin` adapter pattern: `export const adapter = new class ...`, `async load()`, `Bot.adapter.push(adapter)`, and a guarded startup call so TRSS-Yunzai can call `adapter.load()` again without double-starting the server.
- Good: `Bot[botId].pickFriend("web_123").sendMsg("hi")` works as a synchronous chain call; only `sendMsg` performs async I/O.
- Good: visiting `http://host:port/` returns a plain adapter endpoint message; the browser chat UI is loaded from `sf-web-trss-web`, not from the adapter plugin.
- Good: after clearing browser site data (or opening a fresh/incognito browser), connecting with the same `userQQ` replays the full history including images and audio, because both text and media come from the adapter.
- Good: receiving `history` renders every message synchronously before any `getMedia` round trip completes; a missing media leaves only one placeholder.
- Good: `#web清空记录` sent from QQ clears Redis + media and broadcasts `historyCleared`, so an open Web page also clears its DOM.
- Base: Browser sends `{ type: "message", content: "hi", userQQ: "123" }`; adapter emits a private Yunzai event with `user_id: "web_123"`.
- Base: Browser receives `{ content: "<audio controls src=\"data:audio/mpeg;base64,...\"></audio>" }`; the adapter stores the bytes and writes `<audio controls src="media:<id>"></audio>` into Redis; after reconnect the frontend renders the placeholder and then replaces it with the `getMedia` data URL.
- Bad: copying `sf-web-dev` or `sf-web-trss-web` static output back into `sf-web-adapter/web/public`; the adapter plugin becomes responsible for frontend assets again and future deployment checks drift between repositories.
- Bad: keeping static file serving code that reads `path.join(pluginRoot, "web", "public")` after the `web/` directory has been removed.
- Bad: persisting chat messages or media in IndexedDB/localStorage and treating the browser cache as a source of truth; clearing the page then loses history that still exists on the server.
- Bad: storing base64 data URLs in Redis, or collapsing stored `content` to bare `[图片]` / `[语音]` placeholders so markdown formatting and media identity are lost.
- Bad: making the frontend "清空页面" button send `clearHistory`; it must only clear the DOM.
- Bad: blocking `history` rendering on media prefetch; one slow or missing media must not leave the page blank.
- Bad: allowing an older authenticated socket to send `{ type: "message" }` after a newer socket has become active; the event is emitted from one page while replies go to another page.
- Bad: Marking `pickFriend` as `async`; Yunzai/plugin code that calls `pickFriend(...).sendMsg(...)` receives a Promise and fails before `sendMsg` is reached.
- Bad: Defining `apps/WebManagement.js` without an `index.js` `export { apps }`; the command class exists on disk but Yunzai never registers it.
- Bad: pushing an adapter object without `load()` into `Bot.adapter`; TRSS-Yunzai logs `TypeError: adapter.load is not a function` during `lib/listener/loader.js` adapter loading.

### 6. Tests Required
- Syntax: `node --check` for `index.js`, `model/*.js`, `apps/*.js`, and first-party browser JS.
- Adapter lifecycle: assert `index.js` contains an exported adapter object with `id`, `name`, `version`, `load()`, `Bot.adapter.push(adapter)`, and an idempotent startup guard.
- Contract: connect, authenticate, send a text message, and assert Yunzai receives `message.private`.
- Contract: assert `Bot[botId].pickFriend(user_id).sendMsg` is a function without awaiting `pickFriend`.
- Contract: authenticate socket A, authenticate socket B, then send `message` from socket A and assert no `message.private` event is emitted and socket A receives the inactive-connection error.
- History: send a text+image user message, simulate a bot reply with markdown and an image, then assert `history.messages` has both entries with stable `id`s, original markdown, `media:<id>` references, `medias` metadata, and no base64.
- History cursor: assert `loadHistory` with `before` returns only older entries, and `clearHistory` broadcasts `historyCleared` and leaves `loadHistory` empty.
- Media: `getMedia` with a user-uploaded image `id` returns the original data URL; send inbound image base64 and outbound image/record segments from `base64://`, `data:`, local path, `file://`, and URL forms, then assert Web UI renders image Markdown and `<audio controls>`.
- Frontend contract: assert `app.js` contains no IndexedDB/MediaCache code, `history` rendering is not blocked by awaits or prefetch, and only the dedicated "清空对话记录" button sends `clearHistory`.
- Frontend rendering: assert the server template resolves `media:<id>` to a placeholder before fetching and to the data URL after `getMedia`, while preserving markdown.
- Static deployment: parse root `index.html` and assert every relative `href`/`src` target exists under the repository root; search first-party frontend files for stale `public/` asset prefixes. In `sf-web-adapter`, assert documentation does not describe `http://host:port` as an embedded UI after `web/` removal.
- Versioning: assert `index.html` query versions and `sw.js` cache URLs stay in sync after changing `app.js` or `main.css`.
- Dependency: assert `package.json` and `sf-web-adapter/package.json` only add `ws` for this adapter.

### 7. Wrong vs Correct

#### Wrong
```javascript
const adapter = {
  id: "sf-web-adapter",
  name: "Web Adapter",
}

Bot.adapter.push(adapter) // TRSS-Yunzai later calls adapter.load() and crashes.
```

#### Correct
```javascript
export const adapter = new class SFWebAdapter {
  id = "sf-web-adapter"
  name = "Web Adapter"
  version = "v1.0.0"
  _loaded = false

  async load() {
    if (this._loaded) return
    this._loaded = true
    // Create Bot instance and start the WebSocket service here.
  }
}

Bot.adapter.push(adapter)

const appFiles = fs.readdirSync(appRoot).filter(file => file.endsWith('.js'))
const appResults = await Promise.allSettled(appFiles.map(file => import(`./apps/${file}`)))
const apps = {}
for (let i = 0; i < appFiles.length; i++) {
  apps[appFiles[i].replace(/\.js$/, '')] = appResults[i].value[Object.keys(appResults[i].value)[0]]
}

export { apps }
```

#### Wrong
```javascript
async pickFriend(data, user_id) {
  return {
    sendMsg: msg => this.sendFriendMsg(data, msg),
  }
}

Bot[botId].pickFriend(user_id).sendMsg("hi") // sendMsg is undefined because pickFriend returned a Promise.
```

#### Correct
```javascript
pickFriend(data, user_id) {
  return {
    sendMsg: msg => this.sendFriendMsg(data, msg),
  }
}
```

#### Wrong
```javascript
// Treating the browser cache as the source of truth.
const restored = await MediaCache.restoreMessageMedia(historyMessage.content, "bot")
markdownContent.innerHTML = MarkdownRenderer.render(restored)
```

#### Correct
```javascript
// Render the server template immediately, then let getMedia refresh this entry.
const element = MessageManager.addMessage(historyMessage.content, "left")
ServerMedia.watch(element, historyMessage.content, userQQ)
```

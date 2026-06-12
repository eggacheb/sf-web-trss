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
- WebSocket input: `{ type: "auth" | "loadHistory" | "message" | "clearHistory", ... }`.
- Frontend WebSocket URL resolver: when the page runs under `https:`, connect through the existing proxy endpoints instead of opening mixed-content `ws://` directly. Domain-like hosts (`/[a-zA-Z]/`) use `wss://hws.maliya.top/proxy?url=${encodeURIComponent("ws://host:port")}`; numeric IP hosts use `wss://sfws.maliy.top?url=${encodeURIComponent("ws://host:port")}`. Non-HTTPS local HTTP pages may connect directly to `ws://host:port`.
- Static frontend ownership: `sf-web-adapter/` no longer owns a `web/public/` browser UI tree. Static UI files belong in the standalone `sf-web-trss-web` repository root. Do not reintroduce copied frontend build output into `sf-web-adapter/`; deploy the frontend independently and connect it to the adapter's `ws://host:port` endpoint.
- Adapter HTTP server: keep the HTTP server only as the WebSocket same-port carrier. `/` or `/index.html` may return a plain endpoint message, but it must not read from `web/public/` or serve copied frontend assets.
- Yunzai event: `Bot.em("message.private", e)`.
- Reply path: `adapter.sendFriendMsg(data, msg)`.
- Friend picker: `adapter.pickFriend(data, user_id)` / `Bot[botId].pickFriend(user_id)` must return the friend sendable object synchronously. Its `sendMsg` method may return a Promise, but `pickFriend(...).sendMsg(...)` must be chain-callable without `await`.
- Redis key: `sf_web_adapter:history:{userQQ}`.

### 3. Contracts
- `auth` request: `{ password?: string }`; response: `{ type: "auth", success: boolean, message?: string }`.
- `loadHistory` request: `{ type: "loadHistory", userQQ: string, timestamp?: number }`; response: `{ type: "history", messages: Array<{ role: "user" | "bot", content: string, timestamp?: number }> }`.
- `message` request: `{ type: "message", content?: string, images?: string[], userQQ: string, timestamp?: number }`.
- `clearHistory` request: `{ type: "clearHistory", userQQ: string }`; response: `{ type: "historyCleared" }`.
- Single-active WebSocket: after a WebSocket authenticates, it becomes the only active connection for `loadHistory`, `message`, and `clearHistory`. Older authenticated sockets may remain open, but they must not inject messages into Yunzai or mutate Redis history.
- Yunzai event fields must include `bot`, `self_id`, `post_type: "message"`, `message_type: "private"`, `user_id: "web_${userQQ}"`, `sender`, `message`, `raw_message`, `original_message`, and `original_raw_message`.
- Outbound image/record segments may use `Buffer`, `base64://`, `data:*;base64`, `file://`, local file paths, or `http(s)://`; the WebSocket response should still use Markdown image data URLs or `<audio controls src="data:...">` without writing media to disk.
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

### 5. Good/Base/Bad Cases
- Good: `apps/WebManagement.js` defines commands and `index.js` exports an `apps` object, so `#web状态`, `#web重启`, and `#web清空记录` are registered.
- Good: `index.js` follows the `TRSS-WeChat-OC-Plugin` adapter pattern: `export const adapter = new class ...`, `async load()`, `Bot.adapter.push(adapter)`, and a guarded startup call so TRSS-Yunzai can call `adapter.load()` again without double-starting the server.
- Good: `Bot[botId].pickFriend("web_123").sendMsg("hi")` works as a synchronous chain call; only `sendMsg` performs async I/O.
- Good: a Netlify-hosted `https://...` page builds `wss://hws.maliya.top/proxy?...` for domain targets and `wss://sfws.maliy.top?...` for IP targets, while the same UI served from local HTTP keeps direct `ws://host:port`.
- Good: importing the standalone `sf-web-trss-web` repository into Netlify or Vercel publishes the static UI from the repository root, then the UI connects to the adapter's `ws://host:port` endpoint.
- Good: visiting `http://host:port/` returns a plain adapter endpoint message; the browser chat UI is loaded from `sf-web-trss-web`, not from the adapter plugin.
- Base: Browser sends `{ type: "message", content: "hi", userQQ: "123" }`; adapter emits a private Yunzai event with `user_id: "web_123"`.
- Bad: copying `sf-web-dev` or `sf-web-trss-web` static output back into `sf-web-adapter/web/public`; the adapter plugin becomes responsible for frontend assets again and future deployment checks drift between repositories.
- Bad: keeping static file serving code that reads `path.join(pluginRoot, "web", "public")` after the `web/` directory has been removed.
- Bad: pushing an adapter object without `load()` into `Bot.adapter`; TRSS-Yunzai logs `TypeError: adapter.load is not a function` during `lib/listener/loader.js` adapter loading.
- Bad: Defining `apps/WebManagement.js` without an `index.js` `export { apps }`; the command class exists on disk but Yunzai never registers it.
- Bad: Diverging from the reference plugin path convention by mixing local workspace roots and TRSS runtime roots; install and test the adapter from `plugins/sf-web-adapter` so `model/path.js`, app loading, and resources resolve the same way as `TRSS-WeChat-OC-Plugin`.
- Bad: Marking `pickFriend` as `async`; Yunzai/plugin code that calls `pickFriend(...).sendMsg(...)` receives a Promise and fails before `sendMsg` is reached.
- Bad: Allowing an older authenticated socket to send `{ type: "message" }` after a newer socket has become active; the event is emitted from one page while replies go to another page.

### 6. Tests Required
- Syntax: `node --check` for `index.js`, `model/*.js`, `apps/*.js`, and first-party browser JS.
- Adapter lifecycle: assert `index.js` contains an exported adapter object with `id`, `name`, `version`, `load()`, `Bot.adapter.push(adapter)`, and an idempotent startup guard.
- Contract: connect, authenticate, send a text message, and assert Yunzai receives `message.private`.
- Contract: assert `Bot[botId].pickFriend(user_id).sendMsg` is a function without awaiting `pickFriend`.
- Contract: authenticate socket A, authenticate socket B, then send `message` from socket A and assert no `message.private` event is emitted and socket A receives the inactive-connection error.
- History: send user and bot messages, reconnect, and assert `history.messages` is chronological and capped by `history_max`.
- Clear: trigger both WebSocket `clearHistory` and `#web清空记录`, then assert the Redis key is deleted.
- Media: send inbound image base64 and outbound image/record segments from `base64://`, `data:`, local path, `file://`, and URL forms, then assert Web UI renders image Markdown and `<audio controls>`.
- Static deployment: under an `https:` page location, assert domain targets resolve to the `hws.maliya.top` proxy and IP targets resolve to the `sfws.maliy.top` proxy; under local `http:` assert direct `ws://host:port` is still used.
- Static assets: in `sf-web-trss-web`, parse root `index.html` and assert every relative `href`/`src` target exists under the repository root; search first-party frontend files for stale `public/` asset prefixes. In `sf-web-adapter`, assert documentation does not describe `http://host:port` as an embedded UI after `web/` removal.
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

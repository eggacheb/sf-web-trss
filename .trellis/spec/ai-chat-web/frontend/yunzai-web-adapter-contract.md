# Yunzai Web Adapter Contract

## Scenario: Single-user private Web adapter

### 1. Scope / Trigger
- Trigger: A WebSocket/HTTP plugin replaces a chat adapter entry point and injects browser messages into Yunzai's private message event flow.
- Applies to `sf-web-adapter/` and similar Yunzai plugins that expose `apps/*.js` management commands.

### 2. Signatures
- Plugin app export: `export { apps }` from `index.js`.
- App loader: load every `apps/*.js` module and map each file stem to its first exported class.
- Plugin root path: derive from `fileURLToPath(import.meta.url)`, not only from `process.cwd()/plugins`, so static files resolve in both local review workspaces and Yunzai `plugins/` installs.
- WebSocket input: `{ type: "auth" | "loadHistory" | "message" | "clearHistory", ... }`.
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
- Good: `Bot[botId].pickFriend("web_123").sendMsg("hi")` works as a synchronous chain call; only `sendMsg` performs async I/O.
- Base: Browser sends `{ type: "message", content: "hi", userQQ: "123" }`; adapter emits a private Yunzai event with `user_id: "web_123"`.
- Bad: Defining `apps/WebManagement.js` without an `index.js` `export { apps }`; the command class exists on disk but Yunzai never registers it.
- Bad: Computing `pluginRoot` as `path.join(process.cwd(), "plugins", pluginName)` only; local review workspaces that keep the plugin at repository root will serve 404 for every static asset.
- Bad: Marking `pickFriend` as `async`; Yunzai/plugin code that calls `pickFriend(...).sendMsg(...)` receives a Promise and fails before `sendMsg` is reached.
- Bad: Allowing an older authenticated socket to send `{ type: "message" }` after a newer socket has become active; the event is emitted from one page while replies go to another page.

### 6. Tests Required
- Syntax: `node --check` for `index.js`, `model/*.js`, `apps/*.js`, and first-party browser JS.
- Contract: connect, authenticate, send a text message, and assert Yunzai receives `message.private`.
- Contract: assert `Bot[botId].pickFriend(user_id).sendMsg` is a function without awaiting `pickFriend`.
- Contract: authenticate socket A, authenticate socket B, then send `message` from socket A and assert no `message.private` event is emitted and socket A receives the inactive-connection error.
- History: send user and bot messages, reconnect, and assert `history.messages` is chronological and capped by `history_max`.
- Clear: trigger both WebSocket `clearHistory` and `#web清空记录`, then assert the Redis key is deleted.
- Media: send inbound image base64 and outbound image/record segments from `base64://`, `data:`, local path, `file://`, and URL forms, then assert Web UI renders image Markdown and `<audio controls>`.
- Dependency: assert `package.json` and `sf-web-adapter/package.json` only add `ws` for this adapter.

### 7. Wrong vs Correct

#### Wrong
```javascript
// apps/WebManagement.js exists, but index.js does not export apps.
Bot.adapter.push(adapter)
```

#### Correct
```javascript
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

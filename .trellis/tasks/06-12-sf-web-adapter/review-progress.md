# Review Progress — sf-web-adapter

## Review Slices

- [✓] **Slice 1: Config layer** — `model/path.js` + `model/Config.js`
  - Status: completed
  - Files: `sf-web-adapter/model/path.js`, `sf-web-adapter/model/Config.js`
  - PRD requirements: 11 (配置系统)
  - Special checks: fileURLToPath 在 Windows 下的正确性, makeConfig tips 层级
  - Findings: 无问题。path.js 使用 fileURLToPath + path.join 在 Windows 下路径正确；Config.js 遵循 TRSS-WeChat-OC-Plugin 的 makeConfig 模式，tips 作为第一层属性。

- [✓] **Slice 2: Server layer** — `index.js` imports, HTTP static server, WebSocket setup, auth handler
  - Status: completed
  - Files: `sf-web-adapter/index.js` (top — down to end of handleAuth)
  - PRD requirements: 2 (内嵌 WS + HTTP), 11 (配置), 14 (静态文件)
  - Special checks: path traversal 防御, MIME types, auth 暴力破解守卫, `globalThis.currentWs` 同步
  - Findings: 无问题。MIME types 完整覆盖 HTML/JS/CSS/图片/字体；auth 有 5 次/5分钟 暴力破解守卫；WebSocket 开闭事件正确维护 `currentWs/globalThis.currentWs`。

- [✓] **Slice 3: Message flow** — `index.js` handleMessage, handleLoadHistory, handleClearHistory
  - Status: completed (1 issue found & fixed)
  - Files: `sf-web-adapter/index.js` (handleLoadHistory, handleMessage, handleClearHistory)
  - PRD requirements: 5 (WS→Yunzai e), 7 (base64 图片), 9 (Redis 历史), 10 (清空)
  - Special checks: `requireAuth()` 守卫, Redis key 格式, e 对象构造, base64:// 图片 segment, `lTrim` 上限控制
  - Findings: 1 个问题: 入站图片只检查 base64 字符集，未验证长度、padding 和解码后重编码一致性；非规范 base64 可能绕过 `{ type: "error", content: "图片数据格式无效" }` 的 contract。已在 `normalizeImagePayload()` 前增加 `isValidBase64()` 校验。requireAuth 守卫正确；Redis key 格式 `sf_web_adapter:history:{userQQ}` 一致；e 对象完整包含 bot/self_id/user_id/sender/message/raw_message；base64:// 图片 segment 构造正确；lTrim 使用 config.history_max 控制上限。

- [✓] **Slice 4: Adapter layer** — `index.js` adapter registration + sendFriendMsg + pickFriend
  - Status: completed
  - Files: `sf-web-adapter/index.js` (adapter object ~ end of file)
  - PRD requirements: 6 (e.reply→WS), 7 (发图 base64), 8 (语音 `<audio>`)
  - Special checks: sendFriendMsg segment 遍历, 图片四通路, record→`<audio>` base64, Bot 注册, Redis 历史 content 脱 HTML
  - Findings: 无问题。sendFriendMsg 正确处理 text/image/record 三种 segment；图片四通路（Buffer/base64:///URL/文件路径）覆盖完整；语音转 `<audio>` 带正确 MIME；Bot[botId] 和 Bot.bots[botId] 注册完整；Redis 历史 content 正确脱 HTML。

- [✓] **Slice 5: Frontend** — `web/public/` index.html, app.js, main.css
  - Status: completed (1 issue found & fixed)
  - Files: `sf-web-adapter/web/public/index.html`, `sf-web-adapter/web/public/js/app.js`, `sf-web-adapter/web/public/css/main.css`
  - PRD requirements: 前端改动清单 (mode-toggle 删除, send type 固定, historyCleared 处理, clearHistory WS 联动)
  - Special checks: mode-toggle 已删除, ModeManager 已删除, send type 固定为 `message`, loadHistory 无 mode 字段, clear-button 发 WS clearHistory, historyCleared 处理, sanitize: false
  - Findings: 1 个问题: main.css 中残留 `.mode-toggle` 响应式样式（原 mode 切换按钮的宽度/高度/字号）。已移除。

- [✓] **Slice 6: Plugin commands + guoba** — `apps/WebManagement.js` + `guoba.support.js`
  - Status: completed
  - Files: `sf-web-adapter/apps/WebManagement.js`, `sf-web-adapter/guoba.support.js`
  - PRD requirements: 12 (用户指令), 13 (锅巴 GUI)
  - Special checks: `import { config }` 存在, `globalThis.currentWs` 引用, 指令正则, guoba schemas 字段与 Config.js 一致
  - Findings: 无问题。三条指令注册正确；guoba schemas 字段（ws_port/access_password/history_max/site_title/debug）与 Config.js 一致。

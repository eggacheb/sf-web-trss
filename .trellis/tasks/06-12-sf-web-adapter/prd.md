# brainstorm: sf-web-adapter — Web UI 替换微信的 Yunzai Bot 适配器插件

> **状态：已完成。** 主体实现于 2026-06-13，2026-10-17 收尾并合并进 `main`。
> 机器人侧已稳定运行 4 个多月（线上包与仓库 HEAD 代码逐字节一致，仅换行符差异）。
>
> **架构修订（2026-06-13，commit `df52be4`）**：前端不再内嵌于插件，已拆分到独立仓库
> `sf-web-trss-web`（Netlify / Vercel 静态托管），本插件只提供 WebSocket 服务。
> 下文标 ~~删除线~~ 的需求项、以及 `localhost:8081` 相关描述属于修订前的早期设计，仅作历史记录保留。

## 当前架构（以此为准）

```text
浏览器（sf-web-trss-web 静态站点，可 HTTPS）
        │  ws://host:8082 直连，或 wss:// 经代理
        ▼
sf-web-adapter 插件（0.0.0.0:8082，只跑 WebSocket）
        │  Bot.em("message.private", e)
        ▼
TRSS-Yunzai 内核 → 各功能插件处理
        │  e.reply() → adapter.sendFriendMsg()
        ▼
WebSocket 推回前端（文本 / base64 图片 / base64 语音）
```

两个仓库的分工：

| 仓库 | 职责 | 部署方式 |
|---|---|---|
| `sf-web-trss`（本仓库） | 提供 `sf-web-adapter` 插件、Trellis 工作流与规范 | 放进 Yunzai 的 `plugins/` |
| `sf-web-trss-web` | 浏览器聊天 UI，纯静态资源 | Netlify（publish 目录为仓库根）/ Vercel |

与早期设计的实际差异：

- 插件不再托管 `web/public` 静态文件；HTTP `/` 只返回端点说明，不返回内置 Web UI
- 默认端口由 `8081` 改为 `8082`，并新增 `ws_host` 配置
- 新增 `max_image_size`、`enable_typing` 配置项，`history_max` 默认值改为 500（硬上限 1000）
- HTTPS 页面下的代理连接由前端负责（域名端点与数字 IP 端点各一套）

## Goal

在 Yunzai Bot 生态中创建一个新的适配器插件（sf-web-adapter），用 `sf-web-dev` 的 Web 前端 UI 完全替换微信在 TRSS-WeChat-OC-Plugin 中的角色。用户在浏览器中打开 Web 页面，通过 WebSocket 与插件通信，消息被注入 Yunzai Bot 事件系统，由现有功能插件处理，回复经 WebSocket 推回前端。实现与微信适配器同等的完整消息闭环，但入口从微信 App 换成浏览器 Web 界面。

## What I already know

### 参考项目 A: TRSS-WeChat-OC-Plugin

- Yunzai Bot 适配器插件，在微信个人号 (ilink OpenCloud 协议) 和 Yunzai 之间架桥
- 核心机制：
  - `Bot.adapter.push(adapter)` — 在 Yunzai 适配器列表中注册
  - `Bot[id] = {...}` + `Bot.bots[id] = Bot[id]` — 创建 Bot 实例
  - `Bot.em("message.private", e)` — 将收到的消息发射到 Yunzai 事件系统
  - `adapter.sendFriendMsg()` — Yunzai 插件调用 `e.reply()` 时触发，将回复发回微信
- 消息格式：构造 Yunzai `e` 对象（模仿私聊消息），包含 `bot`/`self_id`/`user_id`/`sender`/`message`/`raw_message` 等字段
- 始终使用 `message_type: "private"`，没有群聊模式
- **图片以 base64 内存传输，不落盘** — CDN 下载 → AES 解密 → 直接 `base64://` 塞入 segment，反之亦然
- **使用 Redis 做持久化（syncBuf、contextToken）**
- 配置使用 Yunzai `makeConfig`，锅巴 GUI 通过 `guoba.support.js` 集成
- 指令应用在 `apps/` 目录下，继承自 Yunzai `plugin` 基类

### 参考项目 B: sf-web-dev（前端）

- 纯 Vanilla JS 单页应用，无前端框架
- 通过 WebSocket JSON 协议通信
- 图片以 base64 通过 WebSocket 传输
- 默认端口 8081
- 原本有 SS/GG/DD 三种模式，需删除模式切换，固定为私聊
- 设置面板「工具」选项卡已有「清空页面」按钮（只清 DOM，不清 Redis）

### 参考项目 C: siliconflow-plugin（原后端）

- 通过**构造模拟 `e` 对象**将 AI 对话路由到 WebSocket，不走适配器注册
- 使用 Redis List 做消息历史持久化
- 图片处理：CQ 码替换、本地文件转 base64 data URI
- WebSocket + HTTP 同端口服务（Express + ws）

### 关键映射关系

| WeChat 适配器 | 新插件 |
|---|---|
| ilink HTTP 轮询 `getUpdates()` 收消息 | WebSocket `on('message')` 收消息 |
| ilink `sendMessage()` 发消息 | WebSocket `send()` 推送到前端 |
| `wx_{微信ID}` 作为 user_id | `web_{userQQ}` 作为 user_id |
| 微信多账号 `config.accounts[]` | 单 Bot 实例 `web_adapter` |
| CDN + AES 加解密 | base64 内存传输，不落盘 |
| 二维码扫码登录 | 密码认证 |
| Redis（syncBuf, contextToken） | Redis List（消息历史，可配置上限） |

### 适用约束

- 项目在 Windows 环境下开发（`d:\code\trsssf`）
- 使用 Node.js，Yunzai Bot 生态
- 只需要 `ws` 作为额外依赖，其余用 Node.js 内置模块
- 前端复用 sf-web-dev 现有代码，做必要简化
- Redis 由 Yunzai 全局注入，无需额外安装配置

## 关键判断：单人使用 + 纯私聊

- **单人使用**：只有 `web_adapter` 一个 Bot 实例，WebSocket 连接跟踪当前连接状态。后连覆盖前连，回复推给当前活跃连接。
- **纯私聊**：去除前端 SS/GG/DD 模式切换，固定为私聊。发消息 type 固定为 `message`，后端全部走 `message_type: "private"`。`loadHistory` 不再需要 `mode` 字段。
- **多用户/权限/历史隔离**：全部不需要。

## Requirements (evolving)

1. 实现一个 Yunzai Bot 适配器插件（单人使用，纯私聊）
2. ~~插件内嵌 WebSocket 服务端 + HTTP 静态文件服务（共用端口）~~ → **已修订**：插件只启动 WebSocket 服务（`ws_host:ws_port`，默认 `0.0.0.0:8082`），静态前端交给独立仓库托管
3. 简化 sf-web-dev 前端：删除模式切换按钮及相关逻辑
4. 调整 WebSocket 协议：移除 type/mode 概念，固定私聊
5. 收到 WebSocket 消息 → 构建 Yunzai e 对象 → `Bot.em("message.private")`
6. Yunzai 插件 `e.reply()` → 通过 WebSocket 推回复到前端
7. 图片全程 base64 内存传输（收：base64 → Yunzai segment；发：读文件 → base64 → WebSocket），不落盘
8. 被动接收语音：语音 `record` segment → 读文件 → base64 → `<audio>` 标签 → WebSocket → 前端自动渲染
9. 消息历史持久化（Redis List，可配置上限）
10. ~~清空历史记录：前端「清空页面」按钮联动清 Redis~~ → **已修订（2026-11-04）**：「清空页面」只清 DOM、保留服务端历史；另设「清空对话记录」按钮发 `clearHistory` 删 Redis + 媒体文件；`#web清空记录` 走同一个清空接口并广播 `historyCleared`。历史本身也改为后端唯一数据源，见下方「消息历史持久化」
11. 配置系统（Yunzai makeConfig）
12. 用户指令（状态查看、重启服务、清空记录）
13. 锅巴 GUI 配置面板
14. ~~托管前端静态文件（HTTP 服务）~~ → **已废弃**：前端拆分至 `sf-web-trss-web`

## Acceptance Criteria (evolving)

> 以下各项于 2026-10-17 核对完成，依据：`review-progress.md` 六轮代码评审 + 机器人侧连续运行 4 个月。

- [x] 浏览器访问独立前端站点 → 显示聊天界面，无模式切换按钮（原设计为 `http://localhost:8081`，现为 `ws://host:8082`）
- [x] 设置密码 → 连接 → 可以在界面上收发消息
- [x] 图片发送和接收在前端正常显示
- [x] 语音接收在前端显示为 HTML5 `<audio>` 播放器
- [x] 消息历史在重新连接后可加载
- [x] 消息历史上限可通过配置调整
- [x] ~~前端「清空页面」按钮同时清空 Redis 历史记录~~ → 已按 2026-11-04 修订撤销，见「清空历史」小节
- [x] Yunzai 指令 `#web清空记录` 可清空 Redis 历史记录
- [x] Yunzai 插件的回复正常推送到前端
- [x] 配置项可通过锅巴面板修改

## Definition of Done

- 完整消息闭环：浏览器发消息 → Yunzai 处理 → 浏览器收回复
- 代码风格对齐 TRSS-WeChat-OC-Plugin 的命名和结构
- 锅巴配置面板可用

## Out of Scope (explicit)

- 多用户/多会话（单人使用）
- 模式切换（SS/GG/DD 全部去掉，固定私聊）
- 群聊消息
- OAuth / JWT 等高级认证
- 消息的端到端加密
- 浏览器端录音发送
- 文件消息（仅图片和被动语音）
- 插件单元测试（手动测试验证）
- Docker 部署
- 兼容 sf-web-dev 原本的 SF-PLUGIN 协议

## 图片处理策略

> **2026-11-04 修订**：下面「不落盘 / Redis 只存占位符」属早期设计，现已改为图片落盘 + `media:<id>` 引用（见「消息历史持久化」）。实时链路仍是 base64 内存传输。

完全参照 TRSS-WeChat-OC-Plugin 的做法，图片只在内存中以 base64 流动，不落盘：

- **收图**：前端 WebSocket `images[]` (base64) → 插件构造 Yunzai segment `{ type: "image", file: "base64://xxx" }` → `Bot.em()` 发射。Yunzai 原生支持 `base64://` 前缀，功能插件直接识别。
- **发图**：Yunzai 插件 `e.reply(segment.image("路径"))` → `sendFriendMsg()` 读文件 → 转 base64 → `![图片](data:image/...;base64,...)` → WebSocket 推送 → 前端 marked 渲染。
- **缓存**：消息缓存（`_cacheMessage`）仅存 5 分钟 × 2 条，用于支持 `e.getReply()`，图片本身是 base64 字符串，不额外占磁盘。
- ~~**历史 Redis** 中图片记录为 `[图片]` 占位，不保留原图。~~ → 现改为图片落盘 + `![图片](media:<id>)` 引用

## 语音处理策略（被动接收）

第一期只做「接收插件发的语音」，不实现浏览器端录音发送。

- Yunzai 插件 `e.reply(segment.record("路径"))` → `sendFriendMsg()` 读文件 → 转 base64
- 根据扩展名推断 MIME：`.ogg` → `audio/ogg`，`.wav` → `audio/wav`，默认 `audio/mpeg`
- 拼入 content：`<audio controls src="data:audio/mpeg;base64,..."></audio>`
- WebSocket 推送 → 前端 marked 渲染（marked 配置 `sanitize: false`，原生支持 HTML 标签不转义）
- 前端无需任何额外代码，`<audio controls>` 自动渲染为 HTML5 播放器
- **raw_message** 记录为 `[语音]` 占位
- ~~历史 Redis 中语音记录为 `[语音]` 占位，不保留音频 base64~~ → 现改为语音落盘 + `<audio controls src="media:<id>">` 引用

## 消息历史持久化

> **2026-11-04 修订：后端唯一数据源。** 原先「前端 IndexedDB 缓存媒体 + Redis 只存占位符」的设计，会让清掉浏览器缓存后历史残缺，「清空页面」还会误删后端历史。现在 Redis 存完整消息，浏览器不保存任何聊天记录。旧 Redis 数据已由使用者清空，不做兼容。

### 目标

- 刷新页面、换浏览器、清浏览器站点数据后都能恢复完整对话（含图片语音与 markdown 排版）
- 重新连接 WebSocket 时一次性从后端加载
- 单人使用，按 userQQ 区分（用户可在设置面板切换 QQ）
- 可通过配置调整历史消息上限，或用 `before` / `limit` 增量拉取
- 「清空页面」只清显示；「清空对话记录」和 Yunzai 指令才删服务端数据

### 存储方式

使用 Yunzai 全局注入的 Redis，以 Redis List 存储历史消息。

**Key 格式：**
```
sf_web_adapter:history:{userQQ}
```

**消息格式（List 中的每个元素）：**
```json
{
  "id": "m_m1abc_xyz123",
  "role": "bot",
  "content": "收到 **好的**\n![图片](media:a1b2c3d4e5f6a7b8.png)",
  "medias": [{ "kind": "image", "id": "a1b2c3d4e5f6a7b8.png", "mime": "image/png", "pos": 0 }],
  "timestamp": 1730000000000
}
```

`content` 保留原文；媒体只写 `media:<id>` 引用，字节落在 `data/media/<userQQ>/`，Redis 不存 base64。

### 读写操作

| 时机 | 操作 |
|---|---|
| 收到用户消息（含图片） | 图片落盘 → `content` 记原文 + `media:<id>` → `redis.rPush` → `redis.lTrim` |
| `sendFriendMsg()` 发出回复 | 实时 WS 推完整 data URL；Redis 副本用 `media:<id>`，同时落盘 → `redis.rPush` → `redis.lTrim` |
| 前端请求 `loadHistory` | `redis.lRange` → 按 `before` / `limit` 裁剪 → 返回 `messages` + `hasMore` |
| 前端补媒体 | `getMedia` 按 id 读盘 → `media` / `mediaMissing` |
| 首次写入（Key 不存在） | `redis.rPush` 自动创建 |

同一文件的并发落盘要合并：Windows 上两个 `writeFile` 撞同一路径会 `EPERM`。

### 清空历史

两个前端按钮语义完全不同：

| 按钮 / 指令 | 触发 | 后端操作 |
|---|---|---|
| 「清空页面」 | 只清 DOM + 会话内存 | **无**，服务端历史保留，重新连接即恢复 |
| 「清空对话记录」 | `ws.send({ type: "clearHistory", userQQ })` | `redis.del(key)` + 删 `data/media/<userQQ>/` → 广播 `historyCleared` |
| `#web清空记录` | `apps/WebManagement.js` | 调同一个 `clearUserHistory()` → 广播 `historyCleared` → 回执（该回执不写进新历史） |

前端收到 `historyCleared` 才清 DOM；这样从 QQ 侧清空时，已经打开的网页也会同步。

### 上限控制

`redis.lTrim(key, -maxHistory, -1)` 在每次写入后执行，确保 List 只保留最新的 `maxHistory` 条。

`maxHistory` 来自配置项，用户可通过锅巴面板调整：

```javascript
// 配置默认值
history_max: 100    // 每用户最多保留 100 条，可在 10-1000 范围配置
```

### raw_message 规则

> 这里说的是注入 Yunzai 的 `raw_message`，仍用占位符；写进 Redis 的 `content` 已按 2026-11-04 修订保留原文 + `media:<id>` 引用，不再剥离。

| 场景 | content |
|---|---|
| 纯文本消息 | `"你好"` |
| 文本 + 图片 | `"看图 [图片]"` |
| 仅图片 | `"[图片]"` |
| bot 回复含语音 | `"[语音]"`（去掉 `<audio>` HTML） |
| 混合消息 | 文本 + `[图片]` + `[语音]` 拼接 |

### 协议汇总

前端 → 插件：

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `password` | 密码认证 |
| `loadHistory` | `userQQ`, `before?`, `limit?` | 加载历史（可选增量游标，不再带 `timestamp`） |
| `message` | `content`, `timestamp`, `images[]`, `userQQ` | 发送消息（固定 type） |
| `clearHistory` | `userQQ` | 只由「清空对话记录」发送，删服务端历史与媒体 |
| `getMedia` | `userQQ`, `id` | 按 id 拉取历史媒体 |

插件 → 前端：

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `success` | 认证结果 |
| `history` | `messages[{id,role,content,medias}]`, `hasMore` | 历史记录列表 |
| `historyCleared` | — | 清空确认（按钮与 `#web清空记录` 都会广播） |
| `media` / `mediaMissing` | `id`, `mime`, `dataUrl` | 媒体响应 |
| `typing` | `active` | 输入状态 |
| `error` | `content` | 错误信息 |
| _(无 type)_ | `content` | 普通回复消息 |

## 前端改动清单

| 位置 | 修改 | 说明 |
|---|---|---|
| `index.html` | 删除 mode-toggle 按钮 | 不需要模式切换 |
| `public/js/app.js` | 删除 `ModeManager` 整个模块 | 不需要模式循环 |
| `public/js/app.js` | 删除 `AppState.currentMode` | 状态简化 |
| `public/js/app.js` | `send()` 中固定 type 为 `message` | 不再使用 ss/gg/dd |
| `public/js/app.js` | `loadHistory` 去掉 mode 字段 | 仅 `userQQ`（可选 `before` / `limit`），不再带 `timestamp` |
| `public/js/app.js` | ~~「清空页面」按钮联动发 `clearHistory` 消息~~ → 已撤销；现由独立的「清空对话记录」按钮发送 |
| `public/js/app.js` | `handleMessage` 处理 `historyCleared` 响应 | 收到后清空 DOM 聊天区域 |
| `public/css/main.css` | 删除 ss-mode/gg-mode/dd-mode 样式 | 不需要三种颜色 |
| 设置面板 | `userQQ`、`botQQ` **保留** | 用于头像和 localStorage，服务端不改动 |
| 前端 | 语音无需改动 | `<audio>` 标签由 marked 自动渲染 |

## Technical Notes

- 参考 TRSS-WeChat-OC-Plugin 的 `index.js` 结构实现适配器
- 参考 `model/Config.js` 的 makeConfig 模式实现配置
- 参考 `model/path.js` 的路径常量模式
- 前端文件放在插件内的 `web/` 目录
- WebSocket 和 HTTP 服务使用同一端口（通过 `http` 模块升级 WebSocket）
- 默认端口 8081
- Redis List key 前缀 `sf_web_adapter:history:`，与 WeChat 适配器的 `WeixinOC:data:` 风格一致
- 清空指令 `#web清空记录` 注册在 `apps/WebManagement.js` 中，遵循 TRSS-WeChat-OC-Plugin 的 `apps/Login.js` 指令注册模式

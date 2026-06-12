# SF Web Adapter

`sf-web-adapter` 是一个面向 TRSS-Yunzai / Yunzai 的 Web 私聊适配器插件。它在机器人进程内启动 WebSocket 服务，把浏览器侧消息注入为 Yunzai 私聊事件，并把机器人回复回传给当前 Web 会话。

> 本插件现在不再内置 `web/` 静态前端目录。浏览器 UI 已拆分到独立仓库：`https://github.com/eggacheb/sf-web-trss-web`。
> 入口结构参考 `TRSS-WeChat-OC-Plugin`：`index.js` 导出 `adapter`，调用 `Bot.adapter.push(adapter)`，并实现幂等的 `adapter.load()`，以兼容 TRSS-Yunzai 的 adapter loader。

## 功能

- 启动 WebSocket 服务，默认监听 `0.0.0.0:8082`。
- 接收浏览器文本和图片消息，并转换为 `message.private` 事件。
- 支持机器人回复文本、图片、语音到 Web 前端。
- 使用 Redis 保存每个 Web 用户的对话历史。
- 支持访问密码、历史条数、图片大小、输入状态等配置。
- 提供 `#web状态`、`#web重启`、`#web清空记录` 管理命令。

## 安装

将 `sf-web-adapter` 目录放到 Yunzai 的 `plugins/` 目录下，最终结构应类似：

```bash
/path/to/TRSS-Yunzai/plugins/sf-web-adapter/index.js
/path/to/TRSS-Yunzai/plugins/sf-web-adapter/package.json
```

安装依赖：

```bash
cd /path/to/TRSS-Yunzai/plugins/sf-web-adapter
npm install
```

插件只额外依赖 `ws`，不要把独立前端仓库或构建产物放回本插件目录。

## 配置

配置由 `model/Config.js` 通过 Yunzai 的 `makeConfig("SFWebAdapter", ...)` 管理，也可以在锅巴配置面板中修改。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `ws_host` | `0.0.0.0` | WebSocket 监听地址 |
| `ws_port` | `8082` | WebSocket 监听端口 |
| `access_password` | 空 | 访问密码；留空表示免密连接 |
| `site_title` | `云崽 Web 对话` | Bot 身份昵称和前端展示标题 |
| `history_max` | `500` | 每个 Web 用户保留的历史消息数量，最大按代码限制为 `1000` |
| `max_image_size` | `5242880` | 单张入站图片最大字节数，默认 5 MB |
| `enable_typing` | `true` | 是否向 Web 前端发送输入状态 |
| `debug` | `false` | 调试开关 |

修改监听地址、端口或密码后，建议使用 `#web重启` 或重启 Yunzai。

## 前端部署

本插件只负责 adapter 服务端。前端请使用独立仓库部署：

- GitHub: `https://github.com/eggacheb/sf-web-trss-web`
- Netlify: publish directory 使用仓库根目录 `.`
- Vercel: 仓库内已有 `vercel.json`

部署完成后，在前端里填写 adapter 地址，例如：

```text
your-bot-domain.com:8082
```

如果前端运行在 HTTPS 页面下，独立前端会按地址类型使用代理连接：

- 域名目标：`wss://hws.maliya.top/proxy?url=...`
- 数字 IP 目标：`wss://sfws.maliy.top?url=...`
- HTTP 本地页面：直接连接 `ws://host:port`

因为 `web/` 已拆出，本插件启动日志中的 `http://host:port` 只代表 adapter 监听地址。HTTP `/` 只返回一个端点说明，不再提供内置 Web UI 首页。

## WebSocket 协议

客户端连接到：

```text
ws://<host>:<ws_port>
```

如果配置了 `access_password`，客户端需要先发送认证消息：

```json
{ "type": "auth", "password": "your-password" }
```

认证响应：

```json
{ "type": "auth", "success": true }
```

加载历史：

```json
{ "type": "loadHistory", "userQQ": "123456" }
```

发送消息：

```json
{
  "type": "message",
  "userQQ": "123456",
  "content": "你好",
  "images": ["base64-or-data-url"]
}
```

清空历史：

```json
{ "type": "clearHistory", "userQQ": "123456" }
```

服务端返回的常见消息：

- `{ "type": "history", "messages": [...] }`
- `{ "type": "historyCleared" }`
- `{ "type": "typing", "active": true }`
- `{ "content": "机器人回复内容" }`
- `{ "type": "error", "content": "错误原因" }`

同一时间只有最后一个认证成功的 WebSocket 会话可以注入消息和修改历史。旧连接如果继续发送消息，会收到“当前连接已被新的 Web 会话接管”的错误。

## Yunzai 事件映射

浏览器消息会转换为 Yunzai 私聊事件：

- 事件类型：`Bot.em("message.private", e)`
- `self_id`：`web_adapter`
- `user_id`：`web_<userQQ>`
- Redis 历史键：`sf_web_adapter:history:<userQQ>`

机器人回复通过 adapter 的 `sendFriendMsg()` 回传给当前 WebSocket。`Bot["web_adapter"].pickFriend(user_id).sendMsg(msg)` 保持同步链式调用，兼容 Yunzai 插件侧的常见写法。

## 管理命令

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `#web状态` | 所有人 | 查看端口、连接状态和命令列表 |
| `#web重启` | master | 重启 WebSocket 服务 |
| `#web清空记录` | 当前会话 | 清空当前 Web 用户的 Redis 历史记录 |

## 开发检查

提交前至少运行语法检查：

```bash
node --check index.js
node --check apps/WebManagement.js
node --check model/Config.js
node --check model/path.js
```

同时确认 `index.js` 保留 `export const adapter`、`async load()`、`Bot.adapter.push(adapter)` 和 `export { apps }`。TRSS-Yunzai 会在加载适配器时调用 `adapter.load()`，缺少该方法会导致 `TypeError: adapter.load is not a function`。

如果改动了 WebSocket 协议，需要同步检查独立前端仓库 `sf-web-trss-web` 的连接、认证、历史、消息和清空历史流程。

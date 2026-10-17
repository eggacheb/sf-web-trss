# sf-web-trss

给 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) 机器人加一个**网页版聊天入口**的适配器插件。

在浏览器里就能和机器人私聊：消息经 WebSocket 注入 Yunzai 事件系统，由现有功能插件照常处理，回复再经 WebSocket 推回网页。和微信私聊的体验一致，只是把微信 App 换成了浏览器。

## 架构

```text
浏览器（静态前端，可部署在 HTTPS 上）
        │  ws://host:8082 直连，或 wss:// 经代理
        ▼
sf-web-adapter 插件（0.0.0.0:8082，只跑 WebSocket）
        │  Bot.em("message.private", e)
        ▼
TRSS-Yunzai 内核 → 各功能插件
        │  e.reply() → adapter.sendFriendMsg()
        ▼
WebSocket 推回前端（文本 / base64 图片 / base64 语音）
```

插件只做「浏览器 ↔ Yunzai」的桥接，不托管页面。前端是独立的纯静态站点，可以单独部署、单独更新。

## 仓库组成

**本仓库**（`sf-web-trss`）只有服务端插件和开发规范：

| 路径 | 说明 |
|---|---|
| `sf-web-adapter/` | 插件本体，放进 Yunzai 的 `plugins/` 目录 |
| `.trellis/` | Trellis 工作流：任务记录、编码规范、脚本 |
| `AGENTS.md` | AI 助手的项目入口说明 |

**前端在另一个仓库**：[eggacheb/sf-web-trss-web](https://github.com/eggacheb/sf-web-trss-web) —— 纯 HTML/CSS/JS，无构建步骤，Netlify / Vercel 直接托管。

## 快速开始

### 1. 装插件

把 `sf-web-adapter` 目录放进 Yunzai 的 `plugins/`：

```bash
/path/to/TRSS-Yunzai/plugins/sf-web-adapter/
```

安装依赖（只额外依赖 `ws`）：

```bash
cd /path/to/TRSS-Yunzai/plugins/sf-web-adapter
npm install
```

### 2. 部署前端

克隆 [sf-web-trss-web](https://github.com/eggacheb/sf-web-trss-web)，按它 README 的说明部署到 Netlify 或 Vercel。它是纯静态资源，不需要构建。

### 3. 连上

打开前端页面，在设置里填 adapter 地址：

```text
your-bot-domain.com:8082
```

如果填了 `access_password`，连接时输入密码即可。

### 4. 常用命令

在机器人侧发送（QQ 或任意已接入渠道）：

| 命令 | 权限 | 作用 |
|---|---|---|
| `#web状态` | 所有人 | 查看端口、连接状态 |
| `#web重启` | master | 重启 WebSocket 服务 |
| `#web清空记录` | 当前会话 | 清空该 Web 用户的 Redis 历史 |

## 配置

由 `makeConfig("SFWebAdapter", ...)` 管理，也可以在锅巴面板里改。完整表格见 [`sf-web-adapter/README.md`](./sf-web-adapter/README.md#配置)。

几个关键项：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `ws_port` | `8082` | WebSocket 端口 |
| `access_password` | 空 | 留空表示免密 |
| `history_max` | `500` | 每个用户保留的历史条数（硬上限 1000） |
| `max_image_size` | `5242880` | 单张上行图片上限，5 MB |

改完端口或密码后执行 `#web重启`，或者重启 Yunzai。

## 目录结构

```text
trsssf/
├── sf-web-adapter/          插件本体（本仓库的唯一交付物）
│   ├── index.js             WS 服务 + adapter 注册 + 消息收发
│   ├── apps/                #web 管理指令
│   ├── model/               配置与路径
│   └── guoba.support.js     锅巴面板 schema
├── .trellis/                工作流：spec / tasks / workspace
├── AGENTS.md
└── README.md
```

以下目录**不进入本仓库**（已在 `.gitignore` 中排除），只是本地留存的参考资料：

| 目录 | 是什么 |
|---|---|
| `TRSS-WeChat-OC-Plugin/` | 微信个人号适配器，本插件的结构蓝本 |
| `sf-web-dev/` | 最早的前端 UI，插件前端的原料 |
| `sf-web-trss-web/` | 前端的本地检出（有独立 git 仓库） |
| `siliconflow-plugin/` | 早期方案：构造虚拟 `e` 对象把对话塞进 WebSocket |

## 开发

```bash
node --check sf-web-adapter/index.js
node --check sf-web-adapter/apps/WebManagement.js
node --check sf-web-adapter/model/Config.js
node --check sf-web-adapter/model/path.js
```

改 `index.js` 时要保留四件东西，否则 Yunzai 加载会失败：

- `export const adapter`
- `async load()`（幂等，TRSS-Yunzai 的 adapter loader 会调用）
- `Bot.adapter.push(adapter)`
- `export { apps }`

项目的任务记录与编码规范在 `.trellis/` 下，开发流程见 [`.trellis/workflow.md`](./.trellis/workflow.md)。

## 分支约定

**只用 `main`。** 需要开发分支时，合并后立即删除本地和远程分支，不让长期分支堆积。

## 许可证

MIT

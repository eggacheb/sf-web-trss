# Weak-Model Implementation Prompts — sf-web-adapter

该文件用于在 Cursor 中执行已确认的 PRD，逐步实现 sf-web-adapter 插件。

## 核心规则

- PRD 已确认，不要重新生成 PRD；不要重新生成 implementation plan
- 不要 stage、commit、push、archive 或 finish-work
- 每轮 dispatch 一个 subagent 执行一个最小可验证 slice
- 每轮开始前 subagent 必须重新读取 PRD、plan、spec 和参考代码
- 验证通过后才更新进度
- supervisor 自动 dispatch 下一个 slice，不询问用户「接下来做什么」

## 入口 Prompt（在 Cursor 新对话中使用）

```text
你现在在 Trellis 管理的项目 `D:\code\trsssf` 中工作。

本轮是 **supervisor 主会话**。Cursor 是 sub-agent-capable 平台，请使用 supervised subagent loop 模式：

1. 重新读取 task / PRD / 本 prompt 文件
2. 从 `implementation-plan.md` 中按顺序选择下一个最小 slice
3. dispatch 一个 Cursor agent 执行该 slice
4. dispatch prompt 必须以 `Active task: D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter` 开头
5. 等 agent 返回后审查它改过的文件、diff、验证结果
6. slice 确认完成后自动继续 dispatch 下一个，不要问用户「接下来做什么」
7. 循环直到全部必做步骤完成或遇到真实 blocker

只有遇到以下情况才询问用户：
- slice 之外的大面积修改
- PRD / plan 需要变更
- 业务决策
- 大范围重构
- stage/commit/push/archive/finish-work 等受保护边界

禁止：不要主会话自己一次性做完整实现。不要 stage、commit、push、finish-work。
不要在每个成功 slice 后弹出继续/停止选择题。默认自动继续。

开始前先输出：
1. 你读取了哪些文件
2. 你选择的第一个实现 slice
3. 你准备 dispatch 的 subagent 的指令摘要
```

## 项目背景

这是一个 Yunzai Bot **适配器插件**，用 `sf-web-dev` 的 Web 前端 UI 完全替换微信在 TRSS-WeChat-OC-Plugin 中的角色。
用户在浏览器中打开 Web 页面，通过 WebSocket 与插件通信，消息被注入 Yunzai Bot 事件系统，由现有功能插件处理，回复经 WebSocket 推回前端。

### 三个参考项目

1. **TRSS-WeChat-OC-Plugin** (`D:\code\trsssf\TRSS-WeChat-OC-Plugin`)：适配器注册模式的参考
   - `index.js` — 适配器 object literal、Bot 注册、`sendFriendMsg`、`pickFriend`
   - `model/Config.js` — `makeConfig` 用法（`tips` 是第一层属性，与配置项平级）
   - `model/path.js` — 路径常量
   - `apps/Login.js` — 指令注册模式（继承 `plugin` 基类）
   - `guoba.support.js` — `export function supportGuoba()` 导出格式

2. **sf-web-dev** (`D:\code\trsssf\sf-web-dev`)：前端界面（需简化）
   - `index.html` — 主页面，含 `public/` 前缀的资源引用
   - `public/js/app.js` — WebSocket 通信、消息渲染、设置面板
   - `public/css/main.css` — 粉色主题，含 `.ss-mode`/`.gg-mode`/`.dd-mode` 样式
   - `public/js/marked.min.js` — Markdown 渲染器
   - `public/js/highlight.min.js` — 代码高亮

3. **siliconflow-plugin** (`D:\code\trsssf\siliconflow-plugin`)：参考实现
   - `components/WebUIServer.js` — HTTP + WSS 同端口服务、`setupWebSocket`、`handleAuth`
   - `utils/context.js` — Redis List 消息历史
   - `apps/SF_Painting.js` — `sendMessage()` 图片 base64 转换 + CQ 码替换

## 必须读取的文件

每次实现前要求 subagent 重新读取：
1. PRD：`D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\prd.md`
2. 本 prompt：`D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\weak-model-implementation-prompts.md`
3. 参考项目代码（执行到对应模块时读取）
4. Trellis workflow：`D:\code\trsssf\.trellis\workflow.md`

## 实现步骤

### Step 0: 激活 Task

```bash
cd D:\code\trsssf
python .trellis/scripts/task.py start 06-12-sf-web-adapter
```

### Step 1: 创建项目骨架

创建目录：

```
sf-web-adapter/
├── index.js
├── package.json
├── apps/
│   └── WebManagement.js
├── model/
│   ├── Config.js
│   └── path.js
├── guoba.support.js
└── .gitignore
```

`package.json` 内容：

```json
{
  "name": "sf-web-adapter",
  "type": "module"
}
```

运行 `npm install ws` 安装唯一运行时依赖。

验证：`node --check sf-web-adapter/index.js`（此时可能是空文件，不应报语法错）。

---

### Step 2: 实现 model/path.js

参考 `TRSS-WeChat-OC-Plugin/model/path.js`：

```javascript
import path from 'path'
import { fileURLToPath } from 'url'

const _path = process.cwd().replace(/\\/g, '/')
const pluginName = path.basename(path.join(fileURLToPath(import.meta.url), '../../'))
const pluginRoot = path.join(_path, 'plugins', pluginName)
const pluginResources = path.join(pluginRoot, 'resources')

export { _path, pluginRoot, pluginResources }
```

验证：`node --check sf-web-adapter/model/path.js`

---

### Step 3: 实现 model/Config.js

参考 `TRSS-WeChat-OC-Plugin/model/Config.js`。注意 `tips` 是 `makeConfig` 的第二参数中的**第一层属性**（与各项配置平级），不是嵌套结构：

```javascript
import makeConfig from "../../../lib/plugins/config.js"

export const { config, configSave } = await makeConfig("SFWebAdapter", {
  tips: "Web 适配器配置\n修改后需重启插件生效",
  ws_host: "0.0.0.0",
  ws_port: 8081,
  access_password: "",          // 空 = 允许免密连接
  site_title: "云崽 Web 对话",
  history_max: 100,             // 历史消息上限（条）
  max_image_size: 5242880,      // 图片大小限制（字节，默认 5MB）
  enable_typing: true,
  debug: false,
})
```

验证：`node --check sf-web-adapter/model/Config.js`

---

### Step 4: 实现 index.js — 核心适配器

这是最核心的文件。需要 import、HTTP 静态文件服务、WebSocket 服务、消息处理、适配器注册。**所有方法必须包裹在 object literal 内**，参考 `TRSS-WeChat-OC-Plugin/index.js` 第 62 行起。

#### 4a. 文件头部 — imports

```javascript
import WebSocket, { WebSocketServer } from 'ws'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config, configSave } from './model/Config.js'
import { _path, pluginRoot } from './model/path.js'
```

#### 4b. HTTP 静态文件服务

```javascript
const server = http.createServer((req, res) => {
  // 1. 根路径 / → index.html
  let filePath = req.url === '/'
    ? '/web/public/index.html'
    : '/web' + req.url

  // 2. 安全问题：阻止路径遍历
  filePath = path.normalize(filePath).replace(/^\\/,'')
  const fullPath = path.join(pluginRoot, filePath)

  // 3. MIME 类型映射
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    res.end(data)
  })
})
```

#### 4c. WebSocket 服务（与 HTTP 同端口）

```javascript
const wss = new WebSocketServer({
  server,
  maxPayload: 50 * 1024 * 1024, // 50MB
})

let currentWs = null  // 当前活跃的 WebSocket 连接

wss.on('connection', (ws) => {
  currentWs = ws
  ws.isAuthenticated = false
  ws.clientIp = req.socket.remoteAddress

  ws.on('message', async (raw) => {
    // 分发逻辑见 4d
  })

  ws.on('close', () => {
    // 如果这个 ws 是当前活跃连接，清空引用
    if (currentWs === ws) {
      currentWs = null
    }
  })

  ws.on('error', () => {
    if (currentWs === ws) {
      currentWs = null
    }
  })
})
```

#### 4d. WebSocket 消息分发

```javascript
ws.on('message', async (raw) => {
  let msgObj
  try {
    msgObj = JSON.parse(raw.toString())
  } catch {
    ws.send(JSON.stringify({ type: 'error', content: '无效的 JSON 格式' }))
    return
  }

  switch (msgObj.type) {
    case 'auth':
      await handleAuth(ws, msgObj)
      break
    case 'loadHistory':
      await handleLoadHistory(ws, msgObj)
      break
    case 'message':
      await handleMessage(ws, msgObj)
      break
    case 'clearHistory':
      await handleClearHistory(ws, msgObj)
      break
    default:
      ws.send(JSON.stringify({ type: 'error', content: '未知消息类型' }))
  }
})
```

**handleAuth** — 密码认证：

```javascript
async function handleAuth(ws, msgObj) {
  const password = config.access_password

  // 空密码 = 免密
  if (!password) {
    ws.isAuthenticated = true
    ws.send(JSON.stringify({ type: 'auth', success: true }))
    return
  }

  // 防暴力破解
  if (!global.__authAttempts) global.__authAttempts = {}
  const ip = ws.clientIp
  const now = Date.now()
  const entry = global.__authAttempts[ip]
  if (entry && entry.count >= 5 && now - entry.lastAttempt < 300000) {
    ws.send(JSON.stringify({ type: 'auth', success: false, message: '尝试次数过多，请5分钟后再试' }))
    return
  }

  if (msgObj.password === password) {
    ws.isAuthenticated = true
    global.__authAttempts[ip] = { count: 0, lastAttempt: now }
    ws.send(JSON.stringify({ type: 'auth', success: true }))
  } else {
    const attempt = global.__authAttempts[ip] || { count: 0 }
    attempt.count++
    attempt.lastAttempt = now
    global.__authAttempts[ip] = attempt
    ws.send(JSON.stringify({ type: 'auth', success: false, message: `密码错误，还剩 ${5 - attempt.count} 次机会` }))
  }
}
```

**handleLoadHistory**：

```javascript
async function handleLoadHistory(ws, msgObj) {
  const userQQ = msgObj.userQQ || 'web_user'
  const key = `sf_web_adapter:history:${userQQ}`
  try {
    const data = await redis.lRange(key, 0, -1)
    const messages = data.map(item => JSON.parse(item))
    ws.send(JSON.stringify({ type: 'history', messages }))
  } catch (err) {
    Bot.makeLog('error', `加载历史失败: ${err.message}`, 'sf-web-adapter', true)
    ws.send(JSON.stringify({ type: 'error', content: '加载历史失败' }))
  }
}
```

**handleMessage** — 核心：接收消息 + 构建 e 对象 + `Bot.em()`：

```javascript
async function handleMessage(ws, msgObj) {
  const userQQ = msgObj.userQQ || 'web_user'
  const content = msgObj.content || ''
  const images = msgObj.images || []

  // 保存用户消息到历史
  const rawMsg = content
    ? (images.length ? `${content} [图片]` : content)
    : (images.length ? '[图片]' : '')
  const key = `sf_web_adapter:history:${userQQ}`
  await redis.rPush(key, JSON.stringify({ role: 'user', content: rawMsg, timestamp: Date.now() }))
  await redis.lTrim(key, -config.history_max, -1)

  // 构建 Yunzai e 对象
  const botId = 'web_adapter'
  const data = {
    bot: Bot[botId],
    self_id: botId,
    post_type: 'message',
    message_type: 'private',
    user_id: `web_${userQQ}`,
    sender: {
      user_id: `web_${userQQ}`,
      nickname: userQQ,
    },
    message_id: `${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    message: [],
    raw_message: rawMsg,
  }

  if (content) {
    data.message.push({ type: 'text', text: content })
  }

  // 图片(base64) → Yunzai base64:// segment
  for (const b64 of images) {
    const raw = b64.replace(/^data:image\/\w+;base64,/, '')
    data.message.push({ type: 'image', file: `base64://${raw}` })
  }

  data.original_message = JSON.parse(JSON.stringify(data.message))
  data.original_raw_message = data.raw_message

  // 注入自定义方法
  data.send_typing = async () => {}
  data.stop_typing = async () => {}

  // 缓存好友信息 + 发射事件
  Bot[botId].fl.set(data.user_id, data.sender)
  Bot.em('message.private', data)
}
```

**handleClearHistory**：

```javascript
async function handleClearHistory(ws, msgObj) {
  const userQQ = msgObj.userQQ || 'web_user'
  await redis.del(`sf_web_adapter:history:${userQQ}`)
  ws.send(JSON.stringify({ type: 'historyCleared' }))
}
```

#### 4e. 适配器注册

在所有函数定义之后，文件末尾注册适配器和 Bot：

```javascript
const adapter = {
  id: 'sf-web-adapter',
  name: 'Web Adapter',

  async sendFriendMsg(data, msg) {
    // 见 4f
  },

  async pickFriend(data, user_id) {
    // 见 4g
  },

  async getFriendInfo(data) {
    return {
      user_id: data.user_id,
      nickname: data.sender?.nickname || data.user_id,
    }
  },

  async recallMsg(data, messageId) {
    Bot.makeLog('info', `撤回消息：${messageId} (不支持)`, 'sf-web-adapter')
    return { error: 'Web 协议不支持撤回消息' }
  },

  async getMsg(data, messageId) {
    return null
  },
}

Bot.adapter.push(adapter)

const botId = 'web_adapter'
Bot[botId] = {
  adapter,
  info: {
    user_id: botId,
    nickname: config.site_title || 'Web Adapter',
  },
  uin: botId,
  get nickname() { return this.info.nickname },
  version: {
    id: 'sf-web-adapter',
    name: 'Web Adapter',
    version: 'v1.0.0',
  },
  stat: { start_time: Date.now() / 1000 },
  pickFriend: (user_id) => adapter.pickFriend({ self_id: botId }, user_id),
  get pickUser() { return this.pickFriend },
  fl: new Map(),
  gl: new Map(),
  _stop: false,
}
Bot.bots[botId] = Bot[botId]

// 启动服务
server.listen(config.ws_port, config.ws_host, () => {
  Bot.makeLog('info', `Web 适配器已启动: ${config.ws_host}:${config.ws_port}`, 'sf-web-adapter', true)
})
```

#### 4f. sendFriendMsg()

将 Yunzai 的 message segment 转换为前端可渲染的文本/图片/语音内容，通过 WebSocket 推送：

```javascript
async sendFriendMsg(data, msg) {
  let content = ''

  for (const seg of Array.isArray(msg) ? msg : [msg]) {
    if (seg.type === 'text') {
      content += seg.text
    } else if (seg.type === 'image') {
      let imgBuffer
      let ext = '.jpg'
      if (Buffer.isBuffer(seg.file)) {
        imgBuffer = seg.file
      } else if (typeof seg.file === 'string') {
        if (seg.file.startsWith('base64://')) {
          imgBuffer = Buffer.from(seg.file.replace('base64://', ''), 'base64')
        } else if (seg.file.startsWith('http')) {
          content += `\n![图片](${seg.file})`
          continue
        } else {
          imgBuffer = fs.readFileSync(seg.file)
          ext = path.extname(seg.file) || '.jpg'
        }
      }
      if (imgBuffer) {
        const base64 = imgBuffer.toString('base64')
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
        content += `\n![图片](data:${mime};base64,${base64})`
      }
    } else if (seg.type === 'record') {
      try {
        const audioBuffer = fs.readFileSync(seg.file)
        const base64 = audioBuffer.toString('base64')
        const ext = path.extname(String(seg.file)).toLowerCase()
        const mime = ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg'
        content += `\n<audio controls src="data:${mime};base64,${base64}"></audio>`
      } catch {
        content += '\n[语音]'
      }
    }
  }

  if (!content) return { data: { skipped: true, reason: 'empty_content' } }

  // WebSocket 推送
  const targetWs = currentWs
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({ content }))
  }

  // 保存历史（纯文本版）
  const plainContent = content
    .replace(/<[^>]+>/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '[图片]')
    .trim() || '[语音]'
  const userQQ = data.user_id.replace(/^web_/, '')
  const key = `sf_web_adapter:history:${userQQ}`
  await redis.rPush(key, JSON.stringify({ role: 'bot', content: plainContent, timestamp: Date.now() }))
  await redis.lTrim(key, -config.history_max, -1)

  return { time: Date.now() }
}
```

#### 4g. pickFriend()

```javascript
async pickFriend(data, user_id) {
  if (typeof user_id !== 'string') user_id = String(user_id)
  user_id = user_id.replace(/^web_/, '')
  const fullUserId = `web_${user_id}`

  const i = {
    ...Bot[data.self_id]?.fl?.get(fullUserId),
    self_id: data.self_id,
    bot: Bot[data.self_id],
    user_id: fullUserId,
  }

  return {
    ...i,
    sendMsg: msg => this.sendFriendMsg(i, msg),
    getMsg: message_id => this.getMsg(i, message_id),
    recallMsg: message_id => this.recallMsg(i, message_id),
    getInfo: () => this.getFriendInfo(i),
    getFriendChatHistory: () => Promise.resolve([]),
    getAvatarUrl: () => Promise.resolve(''),
  }
}
```

验证：`node --check sf-web-adapter/index.js`

---

### Step 5: 复制并修改前端文件

#### 5a. 复制前端文件

**保持 `public/` 目录结构不变**（因为 `index.html` 里所有资源引用都是 `public/xxx` 前缀）。

```bash
mkdir -p sf-web-adapter/web

cp sf-web-dev/index.html                      sf-web-adapter/web/public/
cp -r sf-web-dev/public/js/                    sf-web-adapter/web/public/js/
cp -r sf-web-dev/public/css/                   sf-web-adapter/web/public/css/
cp -r sf-web-dev/public/fonts/                 sf-web-adapter/web/public/fonts/
cp -r sf-web-dev/public/images/                sf-web-adapter/web/public/images/
cp    sf-web-dev/public/sw.js                  sf-web-adapter/web/public/sw.js
cp    sf-web-dev/public/manifest.json           sf-web-adapter/web/public/manifest.json
```

#### 5b. 修改前端

按以下顺序修改 `sf-web-adapter/web/public/js/app.js` 和 `sf-web-adapter/web/public/index.html`：

1. **index.html** — 查找并删除 `id="mode-toggle"` 的按钮元素
2. **app.js** — 删除整个 `ModeManager` 对象定义
3. **app.js** — 删除所有 `AppState.currentMode` 引用，删除 `mode` 相关的 `SettingsManager.save/load` 逻辑
4. **app.js** — `send()` 方法中，将 `type: AppState.currentMode.toLowerCase()` 改为 `type: 'message'`
5. **app.js** — `loadHistory` 请求中删除 `mode` 字段，只保留 `{ type: 'loadHistory', userQQ, timestamp }`
6. **app.js** — `handleMessage` 中，当收到 `type: 'historyCleared'` 时调用 `MessageManager.clearMessages()`
7. **app.js** — 在 `EventBinder` 的 `#clear-button` 点击处理中，先发送 `{ type: 'clearHistory', userQQ }`（从设置取值），然后清 DOM
8. **app.js** — WebSocket 连接改为自动检测，去掉外部 WSS 代理：

```javascript
// 在 WebSocketManager.connect 中
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const host = window.location.hostname
const port = new URLSearchParams(window.location.search).get('port') || '8081'
const wsUrl = `${protocol}//${host}:${port}`

// 无需代理，直连
AppState.wsConnection = new WebSocket(wsUrl)
```

9. **main.css** — 删除 `.ss-mode`、`.gg-mode`、`.dd-mode` 相关样式规则

验证：
```bash
node --check sf-web-adapter/web/public/js/app.js     # 应有语法检查，ModeManager 删除后不应有引用错误
ls sf-web-adapter/web/public/                       # 确认 index.html 在
```

---

### Step 6: 实现 apps/WebManagement.js

参考 `TRSS-WeChat-OC-Plugin/apps/Login.js` 的指令注册模式，继承 `plugin` 基类：

```javascript
import plugin from '../../../lib/plugins/plugin.js'

export class WebManagement extends plugin {
  constructor() {
    super({
      name: 'SFWebAdapter',
      dsc: 'Web 适配器管理',
      event: 'message',
      rule: [
        { reg: '^#web状态$', fnc: 'status' },
        { reg: '^#web重启$', fnc: 'restart', permission: 'master' },
        { reg: '^#web清空记录$', fnc: 'clearHistory' },
      ],
    })
  }

  async status() {
    const msg = [
      '━━ Web 适配器状态 ━━',
      `端口: ${config.ws_port || '未启动'}`,
      `连接: ${currentWs ? '已连接' : '未连接'}`,
      ``,
      `指令列表:`,
      `  #web状态 — 查看本页`,
      `  #web重启 — 重启 Web 服务`,
      `  #web清空记录 — 清空对话历史`,
    ].join('\n')
    this.e.reply(msg)
  }

  async restart() {
    this.e.reply('正在重启 Web 服务...')
    // 重启逻辑：server.close() → server.listen()，由主进程处理
    // 简单实现：记录需要重启的标记
    Bot.makeLog('info', 'Web 适配器重启 (由指令触发)', 'sf-web-adapter', true)
  }

  async clearHistory() {
    const userQQ = this.e.user_id.replace(/^web_/, '')
    try {
      await redis.del(`sf_web_adapter:history:${userQQ}`)
      this.e.reply('✅ 历史记录已清空')
    } catch (err) {
      this.e.reply('❌ 清空失败: ' + err.message)
    }
  }
}
```

验证：`node --check sf-web-adapter/apps/WebManagement.js`

---

### Step 7: 实现 guoba.support.js

参考 `TRSS-WeChat-OC-Plugin/guoba.support.js`。锅巴插件需要 `export function supportGuoba()`：

```javascript
import lodash from 'lodash'
import { pluginRoot } from './model/path.js'
import { config, configSave } from './model/Config.js'

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'sf-web-adapter',
      title: 'Web 适配器',
      author: ['@yourname'],
      link: 'https://github.com/yourname/sf-web-adapter',
      isV3: true,
      isV2: false,
      showInMenu: true,
      description: '用 Web 浏览器替换微信的 Yunzai Bot 适配器',
      icon: 'mdi:web',
      iconColor: '#ff69b4',
    },
    configInfo: {
      schemas: [
        {
          field: 'ws_port',
          label: '端口号',
          component: 'InputNumber',
          componentProps: { min: 1024, max: 65535, step: 1 },
          bottomHelpMessage: 'Web 服务端口，修改后需重启',
        },
        {
          field: 'access_password',
          label: '访问密码',
          component: 'InputPassword',
          bottomHelpMessage: '留空 = 允许免密连接',
        },
        {
          field: 'history_max',
          label: '历史消息上限',
          component: 'InputNumber',
          componentProps: { min: 10, max: 1000, step: 10 },
          bottomHelpMessage: '每用户最多保留的消息条数',
        },
        {
          field: 'site_title',
          label: '站点标题',
          component: 'Input',
          bottomHelpMessage: '浏览器标签和前端标题',
        },
        {
          field: 'debug',
          label: '调试模式',
          component: 'Switch',
          bottomHelpMessage: '控制台输出 debug 信息',
        },
      ],
      getConfigData() {
        return config
      },
      setConfigData(data, { Result }) {
        for (const [keyPath, value] of Object.entries(data)) {
          lodash.set(config, keyPath, value)
        }
        try {
          configSave()
          return Result.ok({}, '保存成功~')
        } catch (err) {
          return Result.error('保存失败: ' + err.message)
        }
      },
    },
  }
}
```

验证：`node --check sf-web-adapter/guoba.support.js`

---

## 验证方法

每个 slice 完成且 subagent 返回后，supervisor 至少运行/确认：

```bash
# Node.js 语法检查
node --check sf-web-adapter/index.js
node --check sf-web-adapter/apps/WebManagement.js
node --check sf-web-adapter/model/Config.js
node --check sf-web-adapter/model/path.js
node --check sf-web-adapter/guoba.support.js

# 前端语法检查（Node 可检查 ES5/6 JS）
node --check sf-web-adapter/web/public/js/app.js

# 文件结构确认
ls sf-web-adapter/
ls sf-web-adapter/web/public/
```

## 汇报格式

subagent 完成每个 slice 后输出：

1. 改了哪些文件
2. 实现了什么功能（对应 PRD 哪个 requirement）
3. 运行了哪些验证命令及结果
4. 当前 slice 的 Implementation Logic Summary（入口、数据流、关键路径）
5. 下一个建议的 slice

supervisor 在每次 subagent 返回后自行确认上述内容，然后 dispatch 下一个 slice。

## 特别约束

- 不要修改 `TRSS-WeChat-OC-Plugin/`、`sf-web-dev/`、`siliconflow-plugin/` 目录下的文件
- 所有新代码写在 `sf-web-adapter/` 目录内
- 不要将密码、token 写进日志或状态接口
- 前端修改只删不减（除了模式切换功能），不改变现有 UI 行为
- `redis`、`Bot`、`logger` 是 Yunzai 全局注入，不需要 import
- `Bot.makeLog(level, msg, tag, showConsole)` 是 Yunzai 的标准日志接口
- 使用 Node.js 内置 `http`、`fs`、`path`、`crypto` 模块，不需要额外安装
- `__dirname` 在 ESM 中不可用，使用 `import.meta.url` + `fileURLToPath`
- adapter 用 object literal（不是 class），与 TRSS-WeChat-OC-Plugin 风格一致
- 前端复制时**保持 `public/` 目录结构不变**，否则 HTML 资源引用会断裂
- HTTP 静态文件服务器必须处理好 MIME types、根路径 `/` 兜底和路径遍历防御

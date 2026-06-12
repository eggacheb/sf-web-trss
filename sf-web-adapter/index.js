logger.info(logger.yellow("- 正在加载 Web 适配器插件"))

import WebSocket, { WebSocketServer } from 'ws'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './model/Config.js'
import { pluginRoot } from './model/path.js'

const botId = 'web_adapter'
const messageCache = new Map()
const MESSAGE_CACHE_TTL = 5 * 60 * 1000
const MESSAGE_CACHE_LIMIT = 2
const OUTBOUND_MEDIA_LIMIT = 50 * 1024 * 1024
const skipHistoryKeys = globalThis.sfWebAdapterSkipHistoryKeys || new Set()
globalThis.sfWebAdapterSkipHistoryKeys = skipHistoryKeys

function getHistoryLimit() {
  const limit = Number(config.history_max)
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100
}

function getMaxImageSize() {
  const maxSize = Number(config.max_image_size)
  return Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 5 * 1024 * 1024
}

function getBase64Size(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getImageMime(ext) {
  const normalized = String(ext || '').toLowerCase()
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  }
  return mimeMap[normalized] || 'image/jpeg'
}

function getAudioMime(ext) {
  const normalized = String(ext || '').toLowerCase()
  const mimeMap = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mpeg': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.amr': 'audio/amr',
    '.silk': 'audio/silk',
  }
  return mimeMap[normalized] || 'audio/mpeg'
}

function getExtFromMime(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase()
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'audio/silk': '.silk',
  }
  return extMap[normalized] || ''
}

function parseDataUrl(source) {
  const match = String(source).match(/^data:([^;]+);base64,([\s\S]+)$/i)
  if (!match) return null
  return {
    mime: match[1].toLowerCase(),
    base64: match[2].replace(/\s+/g, ''),
  }
}

function normalizeUserQQ(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.replace(/[^\w.-]/g, '_').slice(0, 64) || 'web_user'
}

function buildRawMessage(content, imageCount = 0) {
  const parts = []
  const text = typeof content === 'string' ? content.trim() : ''
  if (text) parts.push(text)
  for (let i = 0; i < imageCount; i++) parts.push('[图片]')
  return parts.join(' ') || '[图片]'
}

function normalizeImagePayload(image) {
  if (typeof image !== 'string') return null

  const raw = image.replace(/^data:image\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '')
  if (!isValidBase64(raw)) return null

  return {
    raw,
    size: getBase64Size(raw),
  }
}

function isValidBase64(raw) {
  if (!raw || raw.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false
  const hasPadding = raw.includes('=')
  if (hasPadding && raw.length % 4 !== 0) return false

  try {
    const buffer = Buffer.from(raw, 'base64')
    if (!buffer.length) return false

    const normalizedInput = hasPadding ? raw : raw.replace(/=+$/, '')
    const normalizedDecoded = hasPadding ? buffer.toString('base64') : buffer.toString('base64').replace(/=+$/, '')
    return normalizedInput === normalizedDecoded
  } catch {
    return false
  }
}

function setCurrentWs(ws) {
  const previous = currentWs
  currentWs = ws
  globalThis.currentWs = ws
  if (previous && previous !== ws) notifyInactiveWs(previous)
}

function clearCurrentWs(ws) {
  if (currentWs === ws) {
    currentWs = null
    globalThis.currentWs = null
  }
}

function notifyInactiveWs(ws) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', content: '当前连接已被新的 Web 会话接管，请重新连接' }))
  }
}

function normalizeSendSegments(msg) {
  return (Array.isArray(msg) ? msg : [msg]).map((seg) => {
    if (seg === null || seg === undefined) return null
    if (typeof seg !== 'object') return { type: 'text', text: String(seg) }
    if (seg.data && typeof seg.data === 'object') {
      return { ...seg.data, type: seg.type }
    }
    return seg
  }).filter(Boolean)
}

async function readMediaSource(source, fallbackExt = '') {
  if (Buffer.isBuffer(source)) {
    return { buffer: source, ext: fallbackExt, mime: '' }
  }

  if (typeof source !== 'string' || !source) return null

  if (source.startsWith('base64://')) {
    return {
      buffer: Buffer.from(source.replace(/^base64:\/\//i, '').replace(/\s+/g, ''), 'base64'),
      ext: fallbackExt,
      mime: '',
    }
  }

  const dataUrl = parseDataUrl(source)
  if (dataUrl) {
    return {
      buffer: Buffer.from(dataUrl.base64, 'base64'),
      ext: getExtFromMime(dataUrl.mime) || fallbackExt,
      mime: dataUrl.mime,
    }
  }

  if (/^https?:\/\//i.test(source)) {
    if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，无法读取远程媒体')
    const response = await fetch(source)
    if (!response.ok) throw new Error(`远程媒体读取失败: HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') || ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > OUTBOUND_MEDIA_LIMIT) throw new Error(`远程媒体过大: ${formatSize(buffer.length)}`)
    return {
      buffer,
      ext: getExtFromMime(contentType) || path.extname(new URL(source).pathname) || fallbackExt,
      mime: contentType.split(';')[0].toLowerCase(),
    }
  }

  const filePath = source.startsWith('file://') ? fileURLToPath(source) : source
  return {
    buffer: fs.readFileSync(filePath),
    ext: path.extname(filePath) || fallbackExt,
    mime: '',
  }
}

function pruneMessageCache(targetBotId) {
  const now = Date.now()
  const entries = []

  for (const [key, entry] of messageCache.entries()) {
    if (entry.expiresAt <= now) {
      messageCache.delete(key)
      continue
    }
    if (entry.botId === targetBotId) entries.push([key, entry])
  }

  entries
    .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
    .slice(MESSAGE_CACHE_LIMIT)
    .forEach(([key]) => messageCache.delete(key))
}

function cacheMessage(targetBotId, message) {
  if (!message?.message_id) return
  const now = Date.now()
  messageCache.set(`${targetBotId}:${message.message_id}`, {
    botId: targetBotId,
    cachedAt: now,
    expiresAt: now + MESSAGE_CACHE_TTL,
    message,
  })
  pruneMessageCache(targetBotId)
}

function getCachedMessage(targetBotId, messageId) {
  if (!messageId) return null
  pruneMessageCache(targetBotId)
  return messageCache.get(`${targetBotId}:${messageId}`)?.message || null
}

function sendTypingState(active) {
  if (!config.enable_typing) return { skipped: true, reason: 'typing_disabled' }
  const targetWs = currentWs
  if (targetWs?.isAuthenticated && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({ type: 'typing', active }))
    return { success: true }
  }
  return { skipped: true, reason: 'no_active_connection' }
}

function getWebUrl() {
  return `http://${config.ws_host}:${config.ws_port}`
}

function skipNextHistory(userId) {
  if (userId) skipHistoryKeys.add(String(userId))
}

function shouldSkipNextHistory(userId) {
  if (!userId) return false
  return skipHistoryKeys.delete(String(userId))
}

function toHistoryContent(content) {
  const raw = String(content)
  const hasAudio = /<audio\b/i.test(raw)
  const hasImage = /!\[.*?\]\(.*?\)|<img\b/i.test(raw)
  const plain = raw
    .replace(/<audio\b[\s\S]*?<\/audio>/gi, ' [语音] ')
    .replace(/<audio\b[^>]*>/gi, ' [语音] ')
    .replace(/<img\b[^>]*>/gi, ' [图片] ')
    .replace(/!\[.*?\]\(.*?\)/g, ' [图片] ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (plain) return plain
  if (hasImage) return '[图片]'
  if (hasAudio) return '[语音]'
  return '[消息]'
}

function closeWebSocketClients() {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(1012, 'Web adapter restarting')
    } else {
      client.terminate()
    }
  }
  if (currentWs) clearCurrentWs(currentWs)
}

async function stopWebServer() {
  closeWebSocketClients()
  if (!server.listening) return { skipped: true, reason: 'not_listening' }

  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  return { stopped: true }
}

async function startWebServer() {
  if (server.listening) return { skipped: true, reason: 'already_listening', url: getWebUrl() }

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.listen(config.ws_port, config.ws_host, onListening)
  })

  Bot.makeLog('info', `Web 适配器已启动: ${getWebUrl()}`, 'sf-web-adapter', true)
  return { started: true, url: getWebUrl() }
}

async function restartWebServer() {
  await stopWebServer()
  return startWebServer()
}

// HTTP 服务仅作为 WebSocket 同端口承载，不再内置静态 Web UI。
const server = http.createServer((req, res) => {
  let urlPath
  try {
    urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('SF Web Adapter WebSocket endpoint')
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

// WebSocket 服务（与 HTTP 同端口）
const wss = new WebSocketServer({
  server,
  maxPayload: 50 * 1024 * 1024,
})

let currentWs = null

globalThis.sfWebAdapter = {
  restartWebServer,
  startWebServer,
  stopWebServer,
  skipNextHistory,
}

wss.on('connection', (ws, req) => {
  ws.isAuthenticated = !config.access_password
  ws.clientIp = req.socket.remoteAddress
  if (ws.isAuthenticated) setCurrentWs(ws)

  ws.on('message', async (raw) => {
    let msgObj
    try {
      msgObj = JSON.parse(raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', content: '无效的 JSON 格式' }))
      return
    }

    try {
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
    } catch (err) {
      Bot.makeLog('error', `WebSocket 消息处理失败: ${err.message}`, 'sf-web-adapter', true)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: '消息处理失败: ' + err.message }))
      }
    }
  })

  ws.on('close', () => {
    clearCurrentWs(ws)
  })

  ws.on('error', () => {
    clearCurrentWs(ws)
  })
})

// ---- 消息处理函数 ----

function requireAuth(ws) {
  if (!ws.isAuthenticated && config.access_password) {
    ws.send(JSON.stringify({ type: 'error', content: '请先进行密码认证' }))
    return false
  }
  return true
}

function requireActiveWs(ws) {
  if (!requireAuth(ws)) return false
  if (currentWs !== ws) {
    notifyInactiveWs(ws)
    return false
  }
  return true
}

async function handleAuth(ws, msgObj) {
  const password = config.access_password

  if (!password) {
    ws.isAuthenticated = true
    setCurrentWs(ws)
    ws.send(JSON.stringify({ type: 'auth', success: true }))
    return
  }

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
    setCurrentWs(ws)
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

async function handleLoadHistory(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  const key = `sf_web_adapter:history:${userQQ}`
  try {
    const data = await redis.lRange(key, 0, -1)
    const messages = []
    for (const item of data) {
      try {
        const parsed = JSON.parse(item)
        if (parsed && typeof parsed.content === 'string' && ['user', 'bot'].includes(parsed.role)) {
          messages.push(parsed)
        }
      } catch (err) {
        Bot.makeLog('warn', `跳过损坏的历史记录: ${err.message}`, 'sf-web-adapter', true)
      }
    }
    ws.send(JSON.stringify({ type: 'history', messages }))
  } catch (err) {
    Bot.makeLog('error', `加载历史失败: ${err.message}`, 'sf-web-adapter', true)
    ws.send(JSON.stringify({ type: 'error', content: '加载历史失败' }))
  }
}

async function handleMessage(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  const content = typeof msgObj.content === 'string' ? msgObj.content : ''
  const images = Array.isArray(msgObj.images) ? msgObj.images : []
  const maxImageSize = getMaxImageSize()
  const normalizedImages = []

  for (const image of images) {
    const normalized = normalizeImagePayload(image)
    if (!normalized) {
      ws.send(JSON.stringify({ type: 'error', content: '图片数据格式无效' }))
      return
    }
    if (normalized.size > maxImageSize) {
      ws.send(JSON.stringify({ type: 'error', content: `图片过大，最大允许 ${formatSize(maxImageSize)}` }))
      return
    }
    normalizedImages.push(normalized.raw)
  }

  if (!content.trim() && normalizedImages.length === 0) return

  const rawMsg = buildRawMessage(content, normalizedImages.length)
  const key = `sf_web_adapter:history:${userQQ}`
  await redis.rPush(key, JSON.stringify({ role: 'user', content: rawMsg, timestamp: Date.now() }))
  await redis.lTrim(key, -getHistoryLimit(), -1)

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

  const imageUrls = normalizedImages.map(raw => `base64://${raw}`)
  for (const file of imageUrls) {
    data.message.push({ type: 'image', file })
  }
  if (imageUrls.length > 0) data.img = imageUrls

  data.original_message = JSON.parse(JSON.stringify(data.message))
  data.original_raw_message = data.raw_message

  data.send_typing = async () => sendTypingState(true)
  data.stop_typing = async () => sendTypingState(false)
  data.getReply = async (replyId = data.reply_id) => getCachedMessage(botId, replyId)

  Bot[botId].fl.set(data.user_id, data.sender)
  cacheMessage(botId, data)
  Bot.em('message.private', data)
}

async function handleClearHistory(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  await redis.del(`sf_web_adapter:history:${userQQ}`)
  ws.send(JSON.stringify({ type: 'historyCleared' }))
}

// ---- 适配器注册 ----

export const adapter = new class SFWebAdapter {
  id = 'sf-web-adapter'
  name = 'Web Adapter'
  version = 'v1.0.0'

  constructor() {
    this.bots = new Map()
    this._loaded = false
    this._loadPromise = null
  }

  createBot() {
    if (Bot[botId] && !Bot[botId]._stop) {
      this.bots.set(botId, Bot[botId])
      return Bot[botId]
    }

    Bot[botId] = {
      adapter: this,
      info: {
        user_id: botId,
        nickname: config.site_title || 'Web Adapter',
      },
      uin: botId,
      get nickname() { return this.info.nickname },
      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: { start_time: Date.now() / 1000 },
      pickFriend: (user_id) => this.pickFriend({ self_id: botId }, user_id),
      get pickUser() { return this.pickFriend },
      getMsg: async (message_id) => this.getMsg({ self_id: botId }, message_id),
      fl: new Map(),
      gl: new Map(),
      gml: new Map(),
      _stop: false,
    }

    Bot.bots[botId] = Bot[botId]
    this.bots.set(botId, Bot[botId])
    Bot.makeLog('mark', `${this.name}(${this.id}) 已连接: ${Bot[botId].nickname}`, botId)
    Bot.em(`connect.${botId}`, { self_id: botId })
    return Bot[botId]
  }

  async load() {
    if (this._loaded) return
    if (this._loadPromise) return this._loadPromise

    this._loadPromise = (async () => {
      try {
        this.createBot()
        await startWebServer()
        this._loaded = true
      } catch (err) {
        this._loadPromise = null
        throw err
      }
    })()

    return this._loadPromise
  }

  async sendFriendMsg(data, msg) {
    let content = ''

    for (const seg of normalizeSendSegments(msg)) {
      if (seg.type === 'text') {
        if (seg.text !== undefined && seg.text !== null) content += String(seg.text)
      } else if (seg.type === 'image') {
        try {
          const media = await readMediaSource(seg.file || seg.url, '.jpg')
          if (!media?.buffer) {
            content += '\n[图片]'
            continue
          }
          const base64 = media.buffer.toString('base64')
          const mime = media.mime?.startsWith('image/') ? media.mime : getImageMime(media.ext)
          content += `\n![图片](data:${mime};base64,${base64})`
        } catch (err) {
          Bot.makeLog('warn', `图片消息转换失败: ${err.message}`, 'sf-web-adapter', true)
          content += '\n[图片]'
        }
      } else if (seg.type === 'record') {
        try {
          const media = await readMediaSource(seg.file || seg.url, '.mp3')
          if (!media?.buffer) {
            content += '\n[语音]'
            continue
          }
          const base64 = media.buffer.toString('base64')
          const mime = media.mime?.startsWith('audio/') ? media.mime : getAudioMime(media.ext)
          content += `\n<audio controls src="data:${mime};base64,${base64}"></audio>`
        } catch (err) {
          Bot.makeLog('warn', `语音消息转换失败: ${err.message}`, 'sf-web-adapter', true)
          content += '\n[语音]'
        }
      } else if (seg.type !== 'at' && seg.type !== 'reply' && seg.type !== 'button') {
        content += JSON.stringify(seg)
      }
    }

    if (!content) return { data: { skipped: true, reason: 'empty_content' } }

    const targetWs = currentWs
    if (targetWs?.isAuthenticated && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify({ content }))
    }

    const fullUserId = typeof data.user_id === 'string' ? data.user_id : 'web_user'
    const userQQ = normalizeUserQQ(fullUserId.replace(/^web_/, ''))
    if (!shouldSkipNextHistory(fullUserId)) {
      const plainContent = toHistoryContent(content)
      const key = `sf_web_adapter:history:${userQQ}`
      await redis.rPush(key, JSON.stringify({ role: 'bot', content: plainContent, timestamp: Date.now() }))
      await redis.lTrim(key, -getHistoryLimit(), -1)
    }

    return { time: Date.now() }
  }

  pickFriend(data, user_id) {
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
      getChatHistory: (messageSeq, count, reverseOrder = true) => this.getFriendMsgHistory(i, messageSeq, count, reverseOrder),
      getFriendChatHistory: (messageSeq, count, reverseOrder = true) => this.getFriendMsgHistory(i, messageSeq, count, reverseOrder),
      getAvatarUrl: () => Promise.resolve(''),
    }
  }

  async getFriendInfo(data) {
    return {
      user_id: data.user_id,
      nickname: data.sender?.nickname || data.user_id,
    }
  }

  async recallMsg(data, messageId) {
    Bot.makeLog('info', `撤回消息：${messageId} (不支持)`, 'sf-web-adapter')
    return { error: 'Web 协议不支持撤回消息' }
  }

  async getMsg(data, messageId) {
    return getCachedMessage(data.self_id, messageId)
  }

  async getFriendMsgHistory(data, messageSeq, count = 1) {
    const message = getCachedMessage(data.self_id, messageSeq)
    if (!message) return []
    return Array.from({ length: Math.max(1, count) }, () => message).slice(0, 1)
  }
}

Bot.adapter.push(adapter)
adapter.load()

let ret = []
const files = fs
  .readdirSync(path.join(pluginRoot, 'apps'))
  .filter(file => file.endsWith('.js'))
files.forEach((file) => {
  ret.push(import(`./apps/${file}`))
})
ret = await Promise.allSettled(ret)
let apps = {}
for (let i in files) {
  const name = files[i].replace('.js', '')
  if (ret[i].status !== 'fulfilled') {
    logger.error(`[Web 适配器] 载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  const moduleExports = ret[i].value
  const exported = moduleExports[Object.keys(moduleExports)[0]]
  if (!exported) {
    logger.error(`[Web 适配器] 载入插件错误：${logger.red(name)} 未找到导出类`)
    continue
  }
  apps[name] = exported
}

export { apps }

logger.info(logger.green("- Web 适配器插件 加载完成"))

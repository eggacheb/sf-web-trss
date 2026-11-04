logger.info(logger.yellow("- 正在加载 Web 适配器插件"))

import WebSocket, { WebSocketServer } from 'ws'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { config } from './model/Config.js'
import { pluginRoot } from './model/path.js'
import { resolveMediaRef, sanitizeMediaLogText } from './model/Media.js'

const pkg = createRequire(import.meta.url)('./package.json')
const ADAPTER_VERSION = pkg.version
logger.info(logger.green(`- Web 适配器版本 ${ADAPTER_VERSION}`))

const botId = 'web_adapter'
const messageCache = new Map()
const MESSAGE_CACHE_TTL = 5 * 60 * 1000
const MESSAGE_CACHE_LIMIT = 2
const OUTBOUND_MEDIA_LIMIT = 50 * 1024 * 1024

// 历史条目里的媒体只存引用，前端按 id 通过 getMedia 拉取，Redis 不存 base64
const MEDIA_REF_PREFIX = 'media:'

// 未单独处理的 segment 用占位符表示，避免把内部 JSON 结构直接显示给用户
const SEGMENT_PLACEHOLDERS = {
  video: '[视频]',
  file: '[文件]',
  forward: '[聊天记录]',
  node: '[聊天记录]',
  face: '[表情]',
  mface: '[表情]',
  bface: '[表情]',
  poke: '[戳一戳]',
  location: '[位置]',
  contact: '[名片]',
  share: '[链接]',
  music: '[音乐]',
  json: '[卡片]',
  xml: '[卡片]',
  dice: '[骰子]',
  rps: '[猜拳]',
}

// 这些占位符代表一整块内容，前后各占一行；表情、戳一戳之类的保持行内
const BLOCK_SEGMENTS = new Set([
  'video', 'file', 'forward', 'node', 'location', 'contact', 'share', 'music', 'json', 'xml',
])

// 诊断用：最近一条外发消息的段落数 / 换行数，#web状态 会显示
let lastSendStats = null

// 媒体持久化
const MEDIA_ROOT = path.join(pluginRoot, 'data', 'media')
const MEDIA_ID_PATTERN = /^[a-f0-9]{16}\.[a-z0-9]{2,5}$/
const MEDIA_EXT_WHITELIST = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif',
  'mp3', 'ogg', 'wav', 'amr', 'silk', 'm4a', 'aac', 'flac',
])
const MEDIA_AUDIO_EXTS = new Set(['mp3', 'ogg', 'wav', 'amr', 'silk', 'm4a', 'aac', 'flac'])
const MEDIA_SWEEP_INTERVAL = 60 * 60 * 1000
const MEDIA_SERVE_LIMIT = 20 * 1024 * 1024
const DEFAULT_MEDIA_RETENTION_DAYS = 14
const DEFAULT_MEDIA_MAX_SIZE_MB = 500

let lastMediaSweepAt = 0
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

// 运行日志统一走这里：只记状态与数量，不记消息正文、密码或 base64。
// debug 开关控制高频细节（媒体读写等），关键事件始终输出。
const LOG_TAG = 'sf-web-adapter'

function logInfo(message) {
  Bot.makeLog('info', `[Web] ${message}`, LOG_TAG, true)
}

function logWarn(message) {
  Bot.makeLog('warn', `[Web] ${message}`, LOG_TAG, true)
}

function logDebug(message) {
  if (!config.debug) return
  Bot.makeLog('info', `[Web][debug] ${message}`, LOG_TAG, true)
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
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

  const mimeMatch = image.match(/^data:(image\/[\w.+-]+);base64,/i)
  const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg'
  const raw = image.replace(/^data:image\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '')
  if (!isValidBase64(raw)) return null

  return {
    raw,
    size: getBase64Size(raw),
    mime,
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
  if (!Buffer.isBuffer(source) && (typeof source !== 'string' || !source)) return null

  // 统一交给 Media.js：内容嗅探 + 异步读取 + 超时/大小限制
  const media = await resolveMediaRef(source, { maxBytes: OUTBOUND_MEDIA_LIMIT })
  return {
    buffer: media.buffer,
    ext: media.extension || fallbackExt,
    mime: media.mimeType === 'application/octet-stream' ? '' : media.mimeType,
  }
}

// ---- 媒体持久化：按内容哈希落盘，按 userQQ 分目录 ----

function getMediaRetentionDays() {
  const days = Number(config.media_retention_days)
  return Number.isFinite(days) && days > 0 ? Math.min(days, 365) : DEFAULT_MEDIA_RETENTION_DAYS
}

function getMediaMaxBytes() {
  const mb = Number(config.media_max_size_mb)
  const value = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 10240) : DEFAULT_MEDIA_MAX_SIZE_MB
  return value * 1024 * 1024
}

function resolveMediaExt(ext, mime, kind) {
  const value = String(ext || '').replace(/^\./, '').toLowerCase()
  if (MEDIA_EXT_WHITELIST.has(value)) return value
  const fromMime = getExtFromMime(mime).replace(/^\./, '')
  if (fromMime && MEDIA_EXT_WHITELIST.has(fromMime)) return fromMime
  return kind === 'record' ? 'mp3' : 'jpg'
}

function getMediaDir(userQQ) {
  return path.join(MEDIA_ROOT, normalizeUserQQ(userQQ))
}

function buildMediaId(buffer, ext) {
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 16)
  return `${hash}.${ext}`
}

const mediaWrites = new Map()

async function saveMedia(userQQ, buffer, ext, mime, kind) {
  if (!buffer?.length) return null
  const safeExt = resolveMediaExt(ext, mime, kind)
  const id = buildMediaId(buffer, safeExt)
  const dir = getMediaDir(userQQ)
  const filePath = path.join(dir, id)
  const meta = {
    id,
    kind,
    mime: mime || (kind === 'record' ? getAudioMime(`.${safeExt}`) : getImageMime(`.${safeExt}`)),
    size: buffer.length,
  }

  // 同一张图会被多条消息同时引用（例如上行图片和机器人回图）。两个 writeFile
  // 并发打开同一路径在 Windows 上会 EPERM，这里把同一目标的写入合并成一个任务。
  const pending = mediaWrites.get(filePath)
  if (pending) {
    try {
      await pending
      return meta
    } catch {
      return null
    }
  }

  const task = (async () => {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, buffer)
  })()
  mediaWrites.set(filePath, task)

  try {
    await task
    logDebug(`媒体落盘 ${userQQ}/${id}（${buffer.length} 字节，${meta.mime}）`)
    return meta
  } catch (err) {
    Bot.makeLog('warn', `媒体落盘失败: ${err.message}`, 'sf-web-adapter', true)
    return null
  } finally {
    mediaWrites.delete(filePath)
  }
}

function resolveMediaPath(userQQ, id) {
  if (!MEDIA_ID_PATTERN.test(String(id || ''))) return null
  const baseDir = path.resolve(getMediaDir(userQQ))
  const filePath = path.resolve(baseDir, id)
  if (!filePath.startsWith(baseDir + path.sep)) return null
  return filePath
}

async function readMediaById(userQQ, id) {
  const filePath = resolveMediaPath(userQQ, id)
  if (!filePath) return null

  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size > MEDIA_SERVE_LIMIT) return null
    const buffer = await fs.promises.readFile(filePath)
    const now = new Date()
    fs.promises.utimes(filePath, now, now).catch(() => {})
    const ext = path.extname(filePath).toLowerCase()
    return {
      buffer,
      mime: MEDIA_AUDIO_EXTS.has(ext.slice(1)) ? getAudioMime(ext) : getImageMime(ext),
    }
  } catch {
    return null
  }
}

async function removeUserMedia(userQQ) {
  try {
    await fs.promises.rm(getMediaDir(userQQ), { recursive: true, force: true })
    logDebug(`媒体目录已删除 ${userQQ}`)
    return true
  } catch (err) {
    Bot.makeLog('warn', `清理用户媒体失败: ${err.message}`, 'sf-web-adapter', true)
    return false
  }
}

async function sweepMediaStorage(force = false) {
  const now = Date.now()
  if (!force && now - lastMediaSweepAt < MEDIA_SWEEP_INTERVAL) return
  lastMediaSweepAt = now

  let userDirs = []
  try {
    userDirs = await fs.promises.readdir(MEDIA_ROOT, { withFileTypes: true })
  } catch {
    return
  }

  const maxAge = getMediaRetentionDays() * 24 * 60 * 60 * 1000
  const maxBytes = getMediaMaxBytes()
  const kept = []
  let total = 0
  let expired = 0
  let released = 0

  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) continue
    const dirPath = path.join(MEDIA_ROOT, userDir.name)

    let files = []
    try {
      files = await fs.promises.readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.isFile()) continue
      const filePath = path.join(dirPath, file.name)
      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat) continue

      if (now - stat.mtimeMs > maxAge) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {})
        expired++
        released += stat.size
        continue
      }

      kept.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs })
      total += stat.size
    }
  }

  let trimmed = 0
  if (total > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of kept) {
      if (total <= maxBytes) break
      await fs.promises.rm(entry.filePath, { force: true }).catch(() => {})
      total -= entry.size
      released += entry.size
      trimmed++
    }
  }

  if (expired || trimmed) {
    logInfo(`媒体清理: 过期 ${expired} 个 / 超限 ${trimmed} 个，释放 ${formatSize(released)}，剩余 ${formatSize(total)}`)
  } else {
    logDebug(`媒体清理: 无需清理（${kept.length} 个文件，${formatSize(total)}）`)
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

function buildHistoryId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function buildStoredImageRef(id) {
  return `![图片](${MEDIA_REF_PREFIX}${id})`
}

function buildStoredAudioRef(id) {
  return `<audio controls src="${MEDIA_REF_PREFIX}${id}"></audio>`
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
  logInfo('服务已停止')
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

  logInfo(`服务已启动 ${getWebUrl()}（鉴权: ${config.access_password ? '已开启' : '免密'}，历史上限 ${getHistoryLimit()} 条，debug: ${config.debug ? '开' : '关'}）`)
  return { started: true, url: getWebUrl() }
}

async function restartWebServer() {
  logInfo('正在重启服务...')
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
  version: ADAPTER_VERSION,
  getSendStats: () => lastSendStats,
  restartWebServer,
  startWebServer,
  stopWebServer,
  skipNextHistory,
  clearUserHistory,
  notifyHistoryCleared,
  logInfo,
}

wss.on('connection', (ws, req) => {
  ws.isAuthenticated = !config.access_password
  ws.clientIp = req.socket.remoteAddress
  ws.connectedAt = Date.now()
  if (ws.isAuthenticated) setCurrentWs(ws)
  logInfo(`客户端连接 ${ws.clientIp || '未知来源'}（${config.access_password ? '待认证' : '免密'}，当前连接数 ${wss.clients.size}）`)

  ws.on('message', async (raw) => {
    let msgObj
    try {
      msgObj = JSON.parse(raw.toString())
    } catch {
      logWarn(`收到无效 JSON ${ws.clientIp || '未知来源'}`)
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
        case 'getMedia':
          await handleGetMedia(ws, msgObj)
          break
        default:
          logWarn(`未知消息类型: ${String(msgObj.type).slice(0, 32)}`)
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
    const wasActive = currentWs === ws
    clearCurrentWs(ws)
    logInfo(`客户端断开 ${ws.clientIp || '未知来源'}（活跃连接${wasActive ? '已释放' : '未受影响'}，剩余 ${wss.clients.size}，持续 ${formatDuration(Date.now() - ws.connectedAt)}）`)
  })

  ws.on('error', () => {
    logWarn(`连接异常 ${ws.clientIp || '未知来源'}`)
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
  const ip = ws.clientIp || '未知来源'

  if (!password) {
    ws.isAuthenticated = true
    setCurrentWs(ws)
    logInfo(`认证通过 ${ip}（免密）`)
    ws.send(JSON.stringify({ type: 'auth', success: true }))
    return
  }

  if (!global.__authAttempts) global.__authAttempts = {}
  const now = Date.now()
  const entry = global.__authAttempts[ip]
  if (entry && entry.count >= 5 && now - entry.lastAttempt < 300000) {
    logWarn(`认证被限流 ${ip}`)
    ws.send(JSON.stringify({ type: 'auth', success: false, message: '尝试次数过多，请5分钟后再试' }))
    return
  }

  if (msgObj.password === password) {
    ws.isAuthenticated = true
    setCurrentWs(ws)
    global.__authAttempts[ip] = { count: 0, lastAttempt: now }
    logInfo(`认证通过 ${ip}`)
    ws.send(JSON.stringify({ type: 'auth', success: true }))
  } else {
    const attempt = global.__authAttempts[ip] || { count: 0 }
    attempt.count++
    attempt.lastAttempt = now
    global.__authAttempts[ip] = attempt
    logWarn(`认证失败 ${ip}（剩余 ${5 - attempt.count} 次机会）`)
    ws.send(JSON.stringify({ type: 'auth', success: false, message: `密码错误，还剩 ${5 - attempt.count} 次机会` }))
  }
}

async function handleLoadHistory(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  const key = `sf_web_adapter:history:${userQQ}`
  try {
    const data = await redis.lRange(key, 0, -1)
    let messages = []
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

    // before 是消息 id，只返回它之前的消息；limit 为 0 时返回全量（受 history_max 约束）
    const before = typeof msgObj.before === 'string' ? msgObj.before : ''
    if (before) {
      const index = messages.findIndex(item => item.id === before)
      if (index >= 0) messages = messages.slice(0, index)
    }

    const requestedLimit = Number(msgObj.limit)
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 1000)
      : 0
    const hasMore = limit > 0 && messages.length > limit
    if (limit > 0) messages = messages.slice(-limit)

    ws.send(JSON.stringify({ type: 'history', messages, hasMore }))
    logInfo(`加载历史 ${userQQ}: 返回 ${messages.length} 条${hasMore ? '（还有更早的）' : ''}${before ? ' [增量]' : ''}`)
    logDebug(`历史详情 ${userQQ}: Redis ${data.length} 条，before=${before || '-'}，limit=${limit || '全量'}`)
  } catch (err) {
    Bot.makeLog('error', `加载历史失败: ${err.message}`, 'sf-web-adapter', true)
    ws.send(JSON.stringify({ type: 'error', content: '加载历史失败' }))
  }
}

async function handleGetMedia(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  const id = typeof msgObj.id === 'string' ? msgObj.id : ''

  if (!MEDIA_ID_PATTERN.test(id)) {
    logDebug(`取媒体 ${userQQ}/${id || '(空)'}: id 非法`)
    ws.send(JSON.stringify({ type: 'mediaMissing', id }))
    return
  }

  const media = await readMediaById(userQQ, id)
  if (!media) {
    logDebug(`取媒体 ${userQQ}/${id}: 文件缺失或已清理`)
    ws.send(JSON.stringify({ type: 'mediaMissing', id }))
    return
  }

  logDebug(`取媒体 ${userQQ}/${id}: 命中 ${media.mime} / ${media.buffer.length} 字节`)
  ws.send(JSON.stringify({
    type: 'media',
    id,
    mime: media.mime,
    dataUrl: `data:${media.mime};base64,${media.buffer.toString('base64')}`,
  }))
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
      logWarn(`消息被拒 ${userQQ}: 图片数据格式无效`)
      ws.send(JSON.stringify({ type: 'error', content: '图片数据格式无效' }))
      return
    }
    if (normalized.size > maxImageSize) {
      logWarn(`消息被拒 ${userQQ}: 图片 ${formatSize(normalized.size)} 超过上限 ${formatSize(maxImageSize)}`)
      ws.send(JSON.stringify({ type: 'error', content: `图片过大，最大允许 ${formatSize(maxImageSize)}` }))
      return
    }
    normalizedImages.push(normalized)
  }

  if (!content.trim() && normalizedImages.length === 0) {
    logDebug(`忽略空消息 ${userQQ}`)
    return
  }

  const rawMsg = buildRawMessage(content, normalizedImages.length)
  const key = `sf_web_adapter:history:${userQQ}`

  // 用户上传的图片也落盘：历史是后端唯一数据源，前端清了缓存也要能取回
  const storedParts = []
  const medias = []
  const text = content.trim()
  if (text) storedParts.push(text)
  for (let i = 0; i < normalizedImages.length; i++) {
    const image = normalizedImages[i]
    try {
      const buffer = Buffer.from(image.raw, 'base64')
      const stored = await saveMedia(userQQ, buffer, '', image.mime, 'image')
      if (stored) {
        medias.push({ kind: 'image', id: stored.id, mime: stored.mime, pos: i })
        storedParts.push(buildStoredImageRef(stored.id))
        continue
      }
    } catch (err) {
      Bot.makeLog('warn', `用户图片落盘失败: ${err.message}`, 'sf-web-adapter', true)
    }
    storedParts.push('[图片]')
  }

  const entry = {
    id: buildHistoryId(),
    role: 'user',
    content: storedParts.join(' ') || '[图片]',
    timestamp: Date.now(),
  }
  if (medias.length) entry.medias = medias
  await redis.rPush(key, JSON.stringify(entry))
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

  const imageUrls = normalizedImages.map(image => `base64://${image.raw}`)
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
  logInfo(`收到消息 ${userQQ}: ${content.length} 字 / ${normalizedImages.length} 张图（${data.message_id}）`)
  logDebug(`已注入 Yunzai ${userQQ}: ${data.message.length} 个 segment，历史 ${entry.id}，落盘媒体 ${medias.length} 个`)
}

// 两处入口（WebSocket clearHistory / #web清空记录）共用同一套清空动作
async function clearUserHistory(userQQ) {
  await redis.del(`sf_web_adapter:history:${userQQ}`)
  await removeUserMedia(userQQ)
}

function notifyHistoryCleared() {
  const ws = currentWs
  if (ws?.isAuthenticated && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'historyCleared' }))
  }
}

async function handleClearHistory(ws, msgObj) {
  if (!requireActiveWs(ws)) return
  const userQQ = normalizeUserQQ(msgObj.userQQ)
  await clearUserHistory(userQQ)
  notifyHistoryCleared()
  logInfo(`清空对话记录 ${userQQ}（来源: Web 按钮）`)
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
        sweepMediaStorage(true).catch(() => {})
        this._loaded = true
      } catch (err) {
        this._loadPromise = null
        throw err
      }
    })()

    return this._loadPromise
  }

  async sendFriendMsg(data, msg) {
    // content 是推给当前页面的实时内容（带 base64）；storedContent 是写进 Redis 的版本，
    // 媒体换成 media:<id> 引用。两者在同一个循环里同步生成，不会出现按位置猜媒体的错位。
    let content = ''
    let storedContent = ''
    let lastWasText = false
    let mediaPos = 0
    const medias = []
    const fullUserId = typeof data.user_id === 'string' ? data.user_id : 'web_user'
    const userQQ = normalizeUserQQ(fullUserId.replace(/^web_/, ''))

    const appendText = (text) => {
      // Yunzai 常把长文本按行拆成多个 text 段传进来。首尾直接相接会把整段黏成
      // 一行，markdown 的标题、引用、表格、代码围栏全部失效，这里补回换行。
      const separator = lastWasText && content && !content.endsWith('\n') ? '\n' : ''
      content += separator + text
      storedContent += separator + text
      if (text) lastWasText = true
    }

    const segments = normalizeSendSegments(msg)
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.type !== 'text') lastWasText = false
      if (seg.type === 'text') {
        if (seg.text !== undefined && seg.text !== null) {
          appendText(String(seg.text))
        }
      } else if (seg.type === 'image') {
        const pos = mediaPos++
        try {
          const media = await readMediaSource(seg.file || seg.url, '.jpg')
          if (!media?.buffer) {
            content += '\n[图片]'
            storedContent += '\n[图片]'
            continue
          }
          const mime = media.mime?.startsWith('image/') ? media.mime : getImageMime(media.ext)
          const stored = await saveMedia(userQQ, media.buffer, media.ext, mime, 'image')
          const base64 = media.buffer.toString('base64')
          content += `\n![图片](data:${mime};base64,${base64})`
          if (stored) {
            medias.push({ kind: 'image', id: stored.id, mime: stored.mime, pos })
            storedContent += `\n${buildStoredImageRef(stored.id)}`
          } else {
            storedContent += '\n[图片]'
          }
        } catch (err) {
          Bot.makeLog('warn', `图片消息转换失败: ${sanitizeMediaLogText(err.message)}`, 'sf-web-adapter', true)
          content += '\n[图片]'
          storedContent += '\n[图片]'
        }
      } else if (seg.type === 'record') {
        const pos = mediaPos++
        try {
          const media = await readMediaSource(seg.file || seg.url, '.mp3')
          if (!media?.buffer) {
            content += '\n[语音]'
            storedContent += '\n[语音]'
            continue
          }
          const mime = media.mime?.startsWith('audio/') ? media.mime : getAudioMime(media.ext)
          const stored = await saveMedia(userQQ, media.buffer, media.ext, mime, 'record')
          const base64 = media.buffer.toString('base64')
          content += `\n<audio controls src="data:${mime};base64,${base64}"></audio>`
          if (stored) {
            medias.push({ kind: 'record', id: stored.id, mime: stored.mime, pos })
            storedContent += `\n${buildStoredAudioRef(stored.id)}`
          } else {
            storedContent += '\n[语音]'
          }
        } catch (err) {
          Bot.makeLog('warn', `语音消息转换失败: ${sanitizeMediaLogText(err.message)}`, 'sf-web-adapter', true)
          content += '\n[语音]'
          storedContent += '\n[语音]'
        }
      } else if (seg.type !== 'at' && seg.type !== 'reply' && seg.type !== 'button') {
        const label = SEGMENT_PLACEHOLDERS[seg.type]
        const text = label || (seg.text ? String(seg.text) : `[${seg.type}]`)
        if (BLOCK_SEGMENTS.has(seg.type)) {
          const separator = content && !content.endsWith('\n') ? '\n' : ''
          content += separator + text
          storedContent += separator + text
          if (i < segments.length - 1) {
            content += '\n'
            storedContent += '\n'
          }
        } else {
          content += text
          storedContent += text
        }
      }
    }

    if (!content) return { data: { skipped: true, reason: 'empty_content' } }

    // 诊断用：状态指令自己不算，避免把上一次查询的结果当成样本
    if (!content.startsWith('━━ Web 适配器状态')) {
      lastSendStats = {
        segments: segments.length,
        newlines: (content.match(/\n/g) || []).length,
        // 零宽空格、行分隔符之类：看着像换行，但 markdown 和浏览器都不认
        invisible: (content.match(/[\u200b\u2028\u2029\ufeff]/g) || []).length,
        chars: content.length,
        at: Date.now(),
      }
    }

    const targetWs = currentWs
    const delivered = !!(targetWs?.isAuthenticated && targetWs.readyState === WebSocket.OPEN)
    if (delivered) {
      targetWs.send(JSON.stringify({ content }))
    }

    const savedToHistory = !shouldSkipNextHistory(fullUserId)
    if (savedToHistory) {
      const key = `sf_web_adapter:history:${userQQ}`
      const entry = {
        id: buildHistoryId(),
        role: 'bot',
        content: storedContent,
        timestamp: Date.now(),
      }
      if (medias.length) entry.medias = medias
      await redis.rPush(key, JSON.stringify(entry))
      await redis.lTrim(key, -getHistoryLimit(), -1)
    }

    sweepMediaStorage().catch(() => {})

    logInfo(`回复 ${userQQ}: ${segments.length} 段 / ${content.length} 字 / ${medias.length} 个媒体，${delivered ? '已推送页面' : '页面未连接（仅存历史）'}${savedToHistory ? '' : '，回执未入历史'}`)
    logDebug(`回复详情 ${userQQ}: 历史 ${savedToHistory ? '已写入' : '跳过'}，媒体 ${medias.map(item => item.id).join(', ') || '无'}`)
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

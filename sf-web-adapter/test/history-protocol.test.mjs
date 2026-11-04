/**
 * 历史同步协议测试（黑盒：只走 WebSocket 消息，不碰内部变量/Redis 实现）
 *
 * 运行：node --test sf-web-adapter/test/history-protocol.test.mjs
 *
 * 插件依赖 Yunzai 运行时注入的 lib/plugins/* 和全局 Bot/redis/logger，
 * 这里在临时目录里搭一套最小运行时，加载的就是仓库里的真实源码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const wsPackageDir = path.dirname(require.resolve('ws'))

// 1x1 透明 PNG，作为独立来源的已知值（不依赖被测代码生成）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const USER_QQ = '123456'

let tmpRoot
let originalCwd
let port
let adapter
let client
let emittedEvents = []
let logLines = []

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port: value } = server.address()
      server.close(() => resolve(value))
    })
  })
}

function buildSandbox() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-adapter-protocol-'))
  const pluginDir = path.join(tmpRoot, 'plugins', 'sf-web-adapter')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.cpSync(sourceRoot, pluginDir, {
    recursive: true,
    filter: (src) => !src.endsWith(`${path.sep}test`) && !src.includes(`${path.sep}data${path.sep}`),
  })

  const libDir = path.join(tmpRoot, 'lib', 'plugins')
  fs.mkdirSync(libDir, { recursive: true })
  fs.writeFileSync(path.join(libDir, 'config.js'), `
export default async function makeConfig(name, defaults) {
  return {
    config: {
      ...defaults,
      ws_host: '127.0.0.1',
      ws_port: Number(process.env.SF_TEST_PORT),
      access_password: '',
      history_max: 500,
      debug: false,
    },
    configSave: async () => {},
  }
}
`)
  fs.writeFileSync(path.join(libDir, 'plugin.js'), `
export default class Plugin {
  constructor(options) { this.options = options }
}
`)

  fs.mkdirSync(path.join(tmpRoot, 'node_modules'), { recursive: true })
  fs.cpSync(wsPackageDir, path.join(tmpRoot, 'node_modules', 'ws'), { recursive: true })
  return pluginDir
}

function installGlobals() {
  emittedEvents = []
  logLines = []
  const lists = new Map()
  globalThis.logger = {
    info() {}, warn() {}, error() {}, mark() {},
    green: (s) => s, yellow: (s) => s, red: (s) => s,
  }
  globalThis.redis = {
    async rPush(key, value) {
      const list = lists.get(key) || []
      list.push(value)
      lists.set(key, list)
      return list.length
    },
    async lTrim(key, start, stop) {
      const list = lists.get(key) || []
      const end = stop === -1 ? list.length : stop + 1
      lists.set(key, list.slice(start, end))
    },
    async lRange(key) {
      return [...(lists.get(key) || [])]
    },
    async del(key) {
      lists.delete(key)
    },
  }
  globalThis.Bot = {
    adapter: [],
    bots: {},
    makeLog(level, message) { logLines.push({ level, message: String(message) }) },
    em(event, data) { emittedEvents.push({ event, data }) },
  }
}

async function sendAndWait(ws, payload, match) {
  const waiter = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`等待 ${JSON.stringify(payload)} 的响应超时`))
    }, 5000)
    const onMessage = (raw) => {
      const obj = JSON.parse(raw.toString())
      if (!match(obj)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(obj)
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify(payload))
  return waiter
}

const loadHistory = (ws, extra = {}) =>
  sendAndWait(ws, { type: 'loadHistory', userQQ: USER_QQ, ...extra }, (m) => m.type === 'history')

// 只通过 loadHistory 观察后端是否就绪，不读取内部状态
async function waitForHistory(ws, predicate) {
  for (let i = 0; i < 40; i++) {
    const history = await loadHistory(ws)
    if (predicate(history.messages)) return history.messages
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待后端历史就绪超时')
}

test('后端是历史消息的唯一数据源', async (t) => {
  originalCwd = process.cwd()
  port = await freePort()
  process.env.SF_TEST_PORT = String(port)
  const pluginDir = buildSandbox()
  installGlobals()
  process.chdir(tmpRoot)

  try {
    const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)
    adapter = mod.adapter
    await adapter.load()

    client = new WebSocket(`ws://127.0.0.1:${port}`)
    await once(client, 'open')
    const auth = await sendAndWait(client, { type: 'auth', password: '' }, (m) => m.type === 'auth')
    assert.equal(auth.success, true)

    // 用户发一条带图消息
    client.send(JSON.stringify({
      type: 'message',
      userQQ: USER_QQ,
      content: '看看这张图',
      images: [PNG_DATA_URL],
      timestamp: Date.now(),
    }))
    await waitForHistory(client, (msgs) => msgs.length === 1 && msgs[0].role === 'user')

    // 机器人回复一条带 markdown 和图片的消息（走 adapter 的公开发送接口）
    await Bot['web_adapter'].pickFriend(`web_${USER_QQ}`).sendMsg([
      { type: 'text', text: '收到' },
      { type: 'text', text: '**好的**' },
      { type: 'image', file: `base64://${PNG_BASE64}` },
    ])

    const messages = await waitForHistory(client, (msgs) => msgs.length === 2)

    await t.test('用户消息仍然被注入为 Yunzai 私聊事件', () => {
      const entry = emittedEvents.find((item) => item.event === 'message.private')
      assert.ok(entry, '要发出 message.private')
      assert.equal(entry.data.user_id, `web_${USER_QQ}`)
      assert.equal(entry.data.raw_message, '看看这张图 [图片]')
      assert.equal(entry.data.message[0].type, 'text')
      assert.equal(entry.data.message[1].type, 'image')
    })

    await t.test('历史条目带稳定 id，且用户消息的图片也有后端媒体引用', () => {
      assert.equal(messages.length, 2, '一条用户消息 + 一条机器人消息')
      assert.equal(messages[0].role, 'user')
      assert.equal(messages[1].role, 'bot')
      for (const msg of messages) {
        assert.match(msg.id, /^m_[\w-]+$/, '每条消息都要有稳定 id')
        assert.ok(!msg.content.includes('base64,'), 'Redis 里不能塞 base64')
        assert.equal(msg.medias.length, 1, '每条消息的媒体都要能从后端取回')
        assert.match(msg.medias[0].id, /^[a-f0-9]{16}\.[a-z0-9]{2,5}$/)
        assert.match(msg.content, /media:[a-f0-9]{16}\.[a-z0-9]{2,5}/, 'content 里用 id 指向媒体')
      }
      assert.notEqual(messages[0].id, messages[1].id)
    })

    await t.test('机器人回复保留 markdown 原文，不做占位符剥离', () => {
      assert.match(messages[1].content, /收到/)
      assert.match(messages[1].content, /\*\*好的\*\*/, '加粗语法要原样保留')
      assert.match(messages[1].content, /!\[图片\]\(media:/, '图片要保留为可还原的引用，而不是裸占位符')
    })

    await t.test('getMedia 能按 id 取回用户上传的原图', async () => {
      const id = messages[0].medias[0].id
      const media = await sendAndWait(
        client,
        { type: 'getMedia', userQQ: USER_QQ, id },
        (m) => m.type === 'media' || m.type === 'mediaMissing',
      )
      assert.equal(media.type, 'media')
      assert.equal(media.id, id)
      assert.equal(media.dataUrl, PNG_DATA_URL)
    })

    await t.test('loadHistory 支持 before 游标做增量拉取', async () => {
      const older = await loadHistory(client, { before: messages[1].id })
      assert.equal(older.messages.length, 1)
      assert.equal(older.messages[0].id, messages[0].id)
    })

    await t.test('clearHistory 清空后端历史并广播，历史不再可加载', async () => {
      const cleared = await sendAndWait(
        client,
        { type: 'clearHistory', userQQ: USER_QQ },
        (m) => m.type === 'historyCleared',
      )
      assert.equal(cleared.type, 'historyCleared')
      const empty = await loadHistory(client)
      assert.deepEqual(empty.messages, [])
    })

    await t.test('语音回复也能从后端完整取回', async () => {
      await Bot['web_adapter'].pickFriend(`web_${USER_QQ}`).sendMsg([
        { type: 'record', file: 'data:audio/wav;base64,QUJDRA==' },
      ])
      const entries = await waitForHistory(client, (msgs) => msgs.length === 1)
      const record = entries[0]
      assert.match(record.content, /<audio controls src="media:[a-f0-9]{16}\.wav"><\/audio>/)
      assert.equal(record.medias[0].kind, 'record')

      const media = await sendAndWait(
        client,
        { type: 'getMedia', userQQ: USER_QQ, id: record.medias[0].id },
        (m) => m.type === 'media' || m.type === 'mediaMissing',
      )
      assert.equal(media.type, 'media')
      assert.equal(media.dataUrl, 'data:audio/wav;base64,QUJDRA==')
    })

    await t.test('只有最后认证的连接能注入消息', async () => {
      const second = new WebSocket(`ws://127.0.0.1:${port}`)
      await once(second, 'open')
      const auth = await sendAndWait(second, { type: 'auth', password: '' }, (m) => m.type === 'auth')
      assert.equal(auth.success, true)

      const error = await sendAndWait(
        client,
        { type: 'message', userQQ: USER_QQ, content: '旧连接' },
        (m) => m.type === 'error',
      )
      assert.match(error.content, /接管/)
      second.close()
    })

    await t.test('关键运行节点都有 info 日志，且不泄露消息正文', () => {
      const infos = logLines.filter((line) => line.level === 'info').map((line) => line.message)
      for (const needle of ['服务已启动', '客户端连接', '认证通过', '收到消息', '回复', '加载历史', '清空对话记录']) {
        assert.ok(infos.some((line) => line.includes(needle)), `缺少 info 日志: ${needle}`)
      }
      assert.ok(infos.every((line) => !line.includes('看看这张图')), '日志不能包含消息正文')
      assert.ok(infos.every((line) => !line.includes('base64,')), '日志不能包含 base64')
      assert.ok(infos.every((line) => !line.includes('[debug]')), 'debug 关闭时不应输出细节日志')
    })
  } finally {
    if (client && client.readyState === WebSocket.OPEN) client.close()
    if (globalThis.sfWebAdapter?.stopWebServer) await globalThis.sfWebAdapter.stopWebServer()
    process.chdir(originalCwd)
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

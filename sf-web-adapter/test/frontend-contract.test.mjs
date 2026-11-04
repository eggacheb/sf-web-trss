/**
 * 前端静态契约 + 渲染行为测试。
 *
 * 前端是纯静态脚本、没有构建步骤，这里用 vm 载入真实的 app.js（只执行顶层定义，
 * 不跑 DOM 初始化），然后从外部观察 ServerMedia 把后端模板还原成内容的行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(fileURLToPath(new URL('../../sf-web-trss-web/', import.meta.url)))
const readFrontend = (relative) => fs.readFileSync(path.join(frontendRoot, relative), 'utf8')
const appSource = readFrontend('js/app.js')
const htmlSource = readFrontend('index.html')
const swSource = readFrontend('sw.js')

function loadFrontendGlobals() {
  const noop = () => {}
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: noop,
    document: {
      addEventListener: noop,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: noop,
      location: { protocol: 'http:' },
      matchMedia: () => ({ matches: false }),
      visualViewport: null,
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem: noop },
    WebSocket: class WebSocket { static OPEN = 1 },
  })
  vm.runInContext(appSource, context)
  return context
}

test('后端模板还原：缺媒体时先显示占位，getMedia 回来后原样补回', () => {
  const context = loadFrontendGlobals()
  const ServerMedia = vm.runInContext('ServerMedia', context)
  const imageId = 'aaaaaaaaaaaaaaaa.png'
  const audioId = 'bbbbbbbbbbbbbbbb.mp3'
  const template = [
    '收到 **好的**',
    `![图片](media:${imageId})`,
    `<audio controls src="media:${audioId}"></audio>`,
  ].join('\n')

  ServerMedia.reset()
  assert.deepEqual([...ServerMedia.extractIds(template)].sort(), [imageId, audioId])

  const before = ServerMedia.materialize(template)
  assert.doesNotMatch(before, /media:/, '未取到媒体时不能把引用暴露给用户')
  assert.match(before, /\*\*好的\*\*/, 'markdown 原文要保留')
  assert.match(before, /\[图片\]/)
  assert.match(before, /\[语音\]/)

  ServerMedia.resolve(imageId, 'data:image/png;base64,AAAA')
  ServerMedia.resolve(audioId, 'data:audio/mpeg;base64,BBBB')
  const after = ServerMedia.materialize(template)
  assert.match(after, /!\[图片\]\(data:image\/png;base64,AAAA\)/)
  assert.match(after, /<audio controls src="data:audio\/mpeg;base64,BBBB"><\/audio>/)
})

test('前端不再保存任何聊天记录，也不按内容猜媒体归属', () => {
  assert.doesNotMatch(appSource, /indexedDB|sf_chat_media_cache|MediaCache|restoreMessageMedia|syncWithHistory/)
  assert.doesNotMatch(appSource, /addMessage\([^)]*shouldSave/)
  assert.match(appSource, /type: 'loadHistory'/, '历史仍然从后端拉')
  assert.match(appSource, /type: 'getMedia'/, '媒体仍然从后端拉')
})

test('历史渲染不被媒体预取阻塞', () => {
  const historyBranch = appSource.slice(
    appSource.indexOf("msgObj.type === 'history'"),
    appSource.indexOf("msgObj.type === 'media'"),
  )
  assert.doesNotMatch(historyBranch, /await|prefetch/, 'history 分支要同步渲染完所有消息')
  assert.match(historyBranch, /ServerMedia\.watch\(/)
})

test('「清空页面」和「清空对话记录」是两个独立操作', () => {
  assert.match(htmlSource, /id="clear-button"/)
  assert.match(htmlSource, /id="clear-history-button"/)
  const clearHistorySends = appSource
    .split('\n')
    .filter((line) => line.includes("type: 'clearHistory'"))
  assert.equal(clearHistorySends.length, 1, '只有清空对话记录按钮会发 clearHistory')
  const clearPageHandler = appSource.slice(
    appSource.indexOf("getElementById('clear-button')"),
    appSource.indexOf("getElementById('clear-history-button')"),
  )
  assert.doesNotMatch(clearPageHandler, /clearHistory/)
  assert.match(clearPageHandler, /MessageManager\.clearMessages\(\)/)
})

test('连接竞态守卫与发版版本同步', () => {
  assert.match(appSource, /event\.target !== AppState\.wsConnection/, '丢弃旧连接迟到的消息')
  assert.match(appSource, /previous\.onclose = null/, '旧连接回调必须解绑')
  assert.match(appSource, /ws\.readyState !== WebSocket\.OPEN/, 'requestHistory 认 socket 真实状态')

  const versions = (text) => [...text.matchAll(/\?v=(\d{8})/g)].map((match) => match[1])
  const htmlVersions = versions(htmlSource)
  const swVersions = versions(swSource)
  assert.ok(htmlVersions.length >= 2 && swVersions.length >= 2)
  assert.equal(new Set([...htmlVersions, ...swVersions]).size, 1, 'index.html 与 sw.js 的版本号要一致')
  assert.match(swSource, /const CACHE_NAME = 'sfchat-v\d+'/, 'SW 缓存名要随发版递增')
})

test('契约要求的静态检查：适配器生命周期、静态资源、依赖', () => {
  const repoRoot = path.resolve(frontendRoot, '..')
  const adapterSource = fs.readFileSync(path.join(repoRoot, 'sf-web-adapter/index.js'), 'utf8')
  assert.match(adapterSource, /export const adapter = new class/)
  assert.match(adapterSource, /async load\(\)/)
  assert.match(adapterSource, /Bot\.adapter\.push\(adapter\)/)
  assert.match(adapterSource, /export \{ apps \}/)

  const refs = [...htmlSource.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !/^(https?:|data:|#|mailto:)/.test(ref))
  assert.ok(refs.length > 0)
  for (const ref of refs) {
    const clean = ref.split('?')[0].replace(/^\.\//, '')
    assert.ok(fs.existsSync(path.join(frontendRoot, clean)), `index.html 引用的资源不存在: ${clean}`)
  }

  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const adapterPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'sf-web-adapter/package.json'), 'utf8'))
  assert.deepEqual(Object.keys(rootPkg.dependencies || {}), ['ws'])
  assert.deepEqual(Object.keys(adapterPkg.dependencies || {}), ['ws'])
})

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 参考 TRSS-WeChat-OC-Plugin/model/Media.js（commit 7f40c82），按本插件只处理图片/语音的场景裁剪

const FORMAT_INFO = {
  jpg: { mimeType: 'image/jpeg', extension: '.jpg', kind: 'image' },
  png: { mimeType: 'image/png', extension: '.png', kind: 'image' },
  gif: { mimeType: 'image/gif', extension: '.gif', kind: 'image' },
  webp: { mimeType: 'image/webp', extension: '.webp', kind: 'image' },
  bmp: { mimeType: 'image/bmp', extension: '.bmp', kind: 'image' },
  tiff: { mimeType: 'image/tiff', extension: '.tiff', kind: 'image' },
  wav: { mimeType: 'audio/wav', extension: '.wav', kind: 'audio' },
  mp3: { mimeType: 'audio/mpeg', extension: '.mp3', kind: 'audio' },
  ogg: { mimeType: 'audio/ogg', extension: '.ogg', kind: 'audio' },
  flac: { mimeType: 'audio/flac', extension: '.flac', kind: 'audio' },
  amr: { mimeType: 'audio/amr', extension: '.amr', kind: 'audio' },
  silk: { mimeType: 'audio/silk', extension: '.silk', kind: 'audio' },
  aac: { mimeType: 'audio/aac', extension: '.aac', kind: 'audio' },
  m4a: { mimeType: 'audio/mp4', extension: '.m4a', kind: 'audio' },
}

const EXTENSION_FORMATS = new Map([
  ['.jpeg', 'jpg'],
  ['.jpe', 'jpg'],
  ...Object.entries(FORMAT_INFO).map(([format, info]) => [info.extension, format]),
])

function hasPrefix(buffer, prefix, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + prefix.length) return false
  return buffer.subarray(offset, offset + prefix.length).equals(prefix)
}

function formatFromName(fileName) {
  return EXTENSION_FORMATS.get(path.extname(fileName || '').toLowerCase()) || ''
}

function formatFromMimeType(mimeType) {
  const normalized = String(mimeType || '').split(';', 1)[0].trim().toLowerCase()
  return Object.entries(FORMAT_INFO).find(([, info]) => info.mimeType === normalized)?.[0] || ''
}

function safeFileName(fileName, fallback = 'file') {
  const normalized = path.basename(String(fileName || '').replaceAll('\\', '/')).trim()
  return normalized || fallback
}

function decodeBase64(payload, label, maxBytes = Infinity) {
  const compact = String(payload).replace(/\s+/g, '')
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`无效的 ${label}`)
  }
  const unpadded = compact.replace(/=+$/, '')
  // 先按长度估算，避免畸形输入先分配一大块内存再报错
  if (Math.floor((unpadded.length * 3) / 4) > maxBytes) {
    throw new Error(`媒体超过 ${maxBytes} 字节上限`)
  }
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4)
  const buffer = Buffer.from(padded, 'base64')
  if (buffer.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new Error(`无效的 ${label}`)
  }
  return buffer
}

function fileNameFromResponse(response, url) {
  const disposition = response.headers.get('content-disposition') || ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  const encoded = utf8Match?.[1] || plainMatch?.[1] || ''
  if (encoded) {
    try {
      return safeFileName(decodeURIComponent(encoded))
    } catch {
      return safeFileName(encoded)
    }
  }
  try {
    return safeFileName(decodeURIComponent(path.basename(url.pathname)), 'file')
  } catch {
    return safeFileName(path.basename(url.pathname), 'file')
  }
}

// 按文件头判断真实格式：扩展名会骗人，QQ/微信下发的图片经常是 .jpg 实为 PNG
export function detectMediaFormat(buffer, fileName = '', declaredMimeType = '') {
  let format = ''

  if (hasPrefix(buffer, Buffer.from([0xff, 0xd8, 0xff]))) format = 'jpg'
  else if (hasPrefix(buffer, Buffer.from('89504e470d0a1a0a', 'hex'))) format = 'png'
  else if (hasPrefix(buffer, Buffer.from('GIF87a')) || hasPrefix(buffer, Buffer.from('GIF89a'))) format = 'gif'
  else if (hasPrefix(buffer, Buffer.from('RIFF')) && hasPrefix(buffer, Buffer.from('WEBP'), 8)) format = 'webp'
  else if (hasPrefix(buffer, Buffer.from('BM'))) format = 'bmp'
  else if (hasPrefix(buffer, Buffer.from('49492a00', 'hex')) || hasPrefix(buffer, Buffer.from('4d4d002a', 'hex'))) format = 'tiff'
  else if (hasPrefix(buffer, Buffer.from('RIFF')) && hasPrefix(buffer, Buffer.from('WAVE'), 8)) format = 'wav'
  else if (hasPrefix(buffer, Buffer.from('ID3')) || (buffer?.[0] === 0xff && (buffer?.[1] & 0xe0) === 0xe0)) format = 'mp3'
  else if (hasPrefix(buffer, Buffer.from('OggS'))) format = 'ogg'
  else if (hasPrefix(buffer, Buffer.from('fLaC'))) format = 'flac'
  else if (hasPrefix(buffer, Buffer.from('#!AMR'))) format = 'amr'
  else if (hasPrefix(buffer, Buffer.from('#!SILK_V3')) || hasPrefix(buffer, Buffer.from('\x02#!SILK_V3', 'binary'))) format = 'silk'
  else if (buffer?.[0] === 0xff && (buffer?.[1] & 0xf6) === 0xf0) format = 'aac'
  else if (hasPrefix(buffer, Buffer.from('ftyp'), 4)) format = 'm4a'

  const detectedFromContent = !!format
  format ||= formatFromMimeType(declaredMimeType)
  format ||= formatFromName(fileName)
  const info = FORMAT_INFO[format]

  return {
    format: format || '',
    mimeType: info?.mimeType || String(declaredMimeType || '').split(';', 1)[0].trim() || 'application/octet-stream',
    extension: info?.extension || path.extname(fileName || '').toLowerCase(),
    kind: info?.kind || 'file',
    detectedFromContent,
  }
}

// 日志里只留形态和长度，避免把 data URL / base64 整段写进日志
export function sanitizeMediaLogText(value) {
  return String(value)
    .replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi, match => {
      const header = match.slice(5, match.indexOf(','))
      return `data:${header},...[length=${match.length}]`
    })
    .replace(/base64:\/\/[A-Za-z0-9+/_=-]+/gi, match => `base64://...[length=${match.length - 9}]`)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, match => {
      try {
        const url = new URL(match)
        if (url.search) url.search = '?...'
        if (url.hash) url.hash = '#...'
        return url.toString()
      } catch {
        return match
      }
    })
}

export function describeMediaRef(mediaRef) {
  if (Buffer.isBuffer(mediaRef)) return `buffer bytes=${mediaRef.length}`
  if (typeof mediaRef !== 'string' || !mediaRef) return `<${typeof mediaRef} media ref>`
  if (/^data:/i.test(mediaRef)) return `data URI length=${mediaRef.length}`
  if (/^base64:\/\//i.test(mediaRef)) return `base64 media length=${mediaRef.length - 9}`
  return `local media name=${safeFileName(mediaRef)} length=${mediaRef.length}`
}

/**
 * 统一的媒体读取入口：Buffer / base64:// / data URI / http(s) / file URI / 本地路径。
 * 所有分支都先做大小检查；本地文件异步读取，远程请求带超时。
 */
export async function resolveMediaRef(mediaRef, options = {}) {
  const {
    timeoutMs = 15000,
    maxBytes = 50 * 1024 * 1024,
    fileName: suppliedFileName = '',
  } = options

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('无效的媒体大小上限')

  let buffer
  let fileName = safeFileName(suppliedFileName, 'file')
  let declaredMimeType = ''

  if (Buffer.isBuffer(mediaRef)) {
    buffer = mediaRef
  } else if (typeof mediaRef === 'string' && mediaRef) {
    if (/^base64:\/\//i.test(mediaRef)) {
      buffer = decodeBase64(mediaRef.slice(9), 'base64 媒体', maxBytes)
    } else if (/^data:/i.test(mediaRef)) {
      const commaIndex = mediaRef.indexOf(',')
      if (commaIndex < 0) throw new Error('无效的 data URI')
      const header = mediaRef.slice(5, commaIndex)
      const parts = header.split(';')
      if (!parts.slice(1).some(part => part.toLowerCase() === 'base64')) {
        throw new Error('只支持 base64 编码的 data URI')
      }
      declaredMimeType = parts[0] || ''
      buffer = decodeBase64(mediaRef.slice(commaIndex + 1), 'data URI', maxBytes)
    } else {
      let parsedUrl = null
      try {
        parsedUrl = new URL(mediaRef)
      } catch {
        parsedUrl = null
      }

      if (parsedUrl?.protocol === 'http:' || parsedUrl?.protocol === 'https:') {
        if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，无法读取远程媒体')
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 15000, 1))
        try {
          const response = await fetch(parsedUrl, { signal: controller.signal })
          if (!response.ok) throw new Error(`远程媒体读取失败: HTTP ${response.status}`)
          const contentLength = Number(response.headers.get('content-length') || 0)
          if (contentLength > maxBytes) throw new Error(`媒体超过 ${maxBytes} 字节上限`)
          buffer = Buffer.from(await response.arrayBuffer())
          declaredMimeType = response.headers.get('content-type') || ''
          if (!suppliedFileName) fileName = fileNameFromResponse(response, parsedUrl)
        } finally {
          clearTimeout(timeout)
        }
      } else {
        let filePath = mediaRef
        if (parsedUrl?.protocol === 'file:') filePath = fileURLToPath(parsedUrl)
        try {
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) throw new Error('媒体路径不是文件')
          if (stat.size > maxBytes) throw new Error(`媒体超过 ${maxBytes} 字节上限`)
          buffer = await fs.readFile(filePath)
          if (!suppliedFileName) fileName = safeFileName(filePath)
        } catch (error) {
          if (parsedUrl || error?.code !== 'ENOENT') throw error
          // 本地文件不存在时，兼容旧的裸 base64 写法
          buffer = decodeBase64(mediaRef, '裸 base64 媒体', maxBytes)
        }
      }
    }
  } else {
    throw new TypeError(`不支持的媒体引用: ${describeMediaRef(mediaRef)}`)
  }

  if (buffer.length > maxBytes) throw new Error(`媒体超过 ${maxBytes} 字节上限`)

  const detected = detectMediaFormat(buffer, fileName, declaredMimeType)
  if (detected.extension) {
    const currentFormat = formatFromName(fileName)
    if (!currentFormat || (detected.detectedFromContent && currentFormat !== detected.format)) {
      fileName = `${path.parse(fileName).name || 'file'}${detected.extension}`
    }
  }

  return { buffer, fileName, ...detected }
}

import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../model/Config.js'

// 与 index.js 共用同一个日志出口，保证前缀和级别一致
const logInfo = (message) => globalThis.sfWebAdapter?.logInfo?.(message)

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
    logInfo(`收到 #web状态 查询（${this.e.user_id}）`)
    const version = globalThis.sfWebAdapter?.version || '未知'
    const stats = globalThis.sfWebAdapter?.getSendStats?.()
    const msg = [
      '━━ Web 适配器状态 ━━',
      `版本: ${version}`,
      `端口: ${config.ws_port || '未启动'}`,
      `连接: ${globalThis.currentWs ? '已连接' : '未连接'}`,
      `最近发送: ${stats ? `${stats.segments} 段 / ${stats.newlines} 换行 / ${stats.chars} 字${stats.invisible ? ` / ${stats.invisible} 个隐藏分隔符` : ''}` : '暂无'}`,
      ``,
      `指令列表:`,
      `  #web状态 — 查看本页`,
      `  #web重启 — 重启 Web 服务`,
      `  #web清空记录 — 清空对话历史`,
    ].join('\n')
    this.e.reply(msg)
  }

  async restart() {
    logInfo(`收到 #web重启 指令（${this.e.user_id}）`)
    await this.e.reply('正在重启 Web 服务...')
    const restartWebServer = globalThis.sfWebAdapter?.restartWebServer
    if (typeof restartWebServer !== 'function') {
      await this.e.reply('❌ Web 服务重启接口不可用')
      return
    }

    try {
      const result = await restartWebServer()
      logInfo(`重启完成: ${result.url}`)
      await this.e.reply('✅ Web 服务已重启')
    } catch (err) {
      Bot.makeLog('error', `[Web] 重启失败: ${err.message}`, 'sf-web-adapter', true)
      await this.e.reply('❌ 重启失败: ' + err.message)
    }
  }

  async clearHistory() {
    const userQQ = this.e.user_id.replace(/^web_/, '')
    logInfo(`收到 #web清空记录 指令（${this.e.user_id}）`)
    try {
      const clearUserHistory = globalThis.sfWebAdapter?.clearUserHistory
      if (typeof clearUserHistory !== 'function') {
        await this.e.reply('❌ 清空失败: Web 适配器未就绪')
        return
      }
      // 与前端「清空对话记录」共用同一套动作，Redis 和媒体目录一起删
      await clearUserHistory(userQQ)
      // 走指令清空时也要让当前页面同步清掉，否则页面还留着已被删除的历史
      globalThis.sfWebAdapter.notifyHistoryCleared?.()
      if (this.e.user_id.startsWith('web_')) {
        const skipNextHistory = globalThis.sfWebAdapter?.skipNextHistory
        if (typeof skipNextHistory === 'function') {
          skipNextHistory(this.e.user_id)
        } else {
          if (!globalThis.sfWebAdapterSkipHistoryKeys) globalThis.sfWebAdapterSkipHistoryKeys = new Set()
          globalThis.sfWebAdapterSkipHistoryKeys.add(this.e.user_id)
        }
      }
      logInfo(`清空对话记录 ${userQQ}（来源: #web清空记录）`)
      await this.e.reply('✅ 历史记录已清空')
    } catch (err) {
      Bot.makeLog('error', `[Web] 清空失败: ${err.message}`, 'sf-web-adapter', true)
      await this.e.reply('❌ 清空失败: ' + err.message)
    }
  }
}

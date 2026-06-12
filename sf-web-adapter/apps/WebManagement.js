import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../model/Config.js'

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
      `连接: ${globalThis.currentWs ? '已连接' : '未连接'}`,
      ``,
      `指令列表:`,
      `  #web状态 — 查看本页`,
      `  #web重启 — 重启 Web 服务`,
      `  #web清空记录 — 清空对话历史`,
    ].join('\n')
    this.e.reply(msg)
  }

  async restart() {
    await this.e.reply('正在重启 Web 服务...')
    const restartWebServer = globalThis.sfWebAdapter?.restartWebServer
    if (typeof restartWebServer !== 'function') {
      await this.e.reply('❌ Web 服务重启接口不可用')
      return
    }

    try {
      const result = await restartWebServer()
      Bot.makeLog('info', `Web 适配器重启完成: ${result.url}`, 'sf-web-adapter', true)
      await this.e.reply('✅ Web 服务已重启')
    } catch (err) {
      Bot.makeLog('error', `Web 适配器重启失败: ${err.message}`, 'sf-web-adapter', true)
      await this.e.reply('❌ 重启失败: ' + err.message)
    }
  }

  async clearHistory() {
    const userQQ = this.e.user_id.replace(/^web_/, '')
    try {
      await redis.del(`sf_web_adapter:history:${userQQ}`)
      if (this.e.user_id.startsWith('web_')) {
        const skipNextHistory = globalThis.sfWebAdapter?.skipNextHistory
        if (typeof skipNextHistory === 'function') {
          skipNextHistory(this.e.user_id)
        } else {
          if (!globalThis.sfWebAdapterSkipHistoryKeys) globalThis.sfWebAdapterSkipHistoryKeys = new Set()
          globalThis.sfWebAdapterSkipHistoryKeys.add(this.e.user_id)
        }
      }
      await this.e.reply('✅ 历史记录已清空')
    } catch (err) {
      await this.e.reply('❌ 清空失败: ' + err.message)
    }
  }
}

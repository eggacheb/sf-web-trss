import { config, configSave } from './model/Config.js'

function setConfigValue(target, keyPath, value) {
  const keys = String(keyPath).split('.').filter(Boolean)
  if (!keys.length) return

  let cursor = target
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'sf-web-adapter',
      title: 'Web 适配器',
      author: ['@eggacheb'],
      authorLink: ['https://github.com/eggacheb'],
      link: 'https://github.com/eggacheb/sf-web-trss',
      isV3: true,
      isV2: false,
      showInMenu: true,
      description: '基于 TRSS-Yunzai 的 Web 私聊适配器插件，将浏览器消息接入 Yunzai 私聊事件流。',
      icon: 'mdi:web',
      iconColor: '#ff69b4',
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: 'WebSocket 服务配置',
          componentProps: {
            orientation: 'left',
            plain: true,
          },
        },
        {
          field: 'ws_host',
          label: '监听地址',
          component: 'Input',
          bottomHelpMessage: 'Web 服务监听地址，默认 0.0.0.0，修改后需重启',
        },
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
          component: 'Divider',
          label: '消息与显示配置',
          componentProps: {
            orientation: 'left',
            plain: true,
          },
        },
        {
          field: 'history_max',
          label: '历史消息上限',
          component: 'InputNumber',
          componentProps: { min: 10, max: 1000, step: 10 },
          bottomHelpMessage: '每用户最多保留的消息条数',
        },
        {
          field: 'max_image_size',
          label: '图片大小上限',
          component: 'InputNumber',
          componentProps: { min: 1048576, max: 52428800, step: 1048576 },
          bottomHelpMessage: '单张 WebSocket 图片最大字节数，默认 5242880',
        },
        {
          field: 'site_title',
          label: '站点标题',
          component: 'Input',
          bottomHelpMessage: '浏览器标签和前端标题',
        },
        {
          component: 'Divider',
          label: '媒体缓存配置',
          componentProps: {
            orientation: 'left',
            plain: true,
          },
        },
        {
          field: 'media_retention_days',
          label: '媒体保留天数',
          component: 'InputNumber',
          componentProps: { min: 1, max: 365, step: 1 },
          bottomHelpMessage: '图片与语音在服务端保留的天数，默认 14 天；清空对话时会立即删除',
        },
        {
          field: 'media_max_size_mb',
          label: '媒体缓存上限 (MB)',
          component: 'InputNumber',
          componentProps: { min: 50, max: 10240, step: 50 },
          bottomHelpMessage: '媒体目录总大小上限，超出后按最旧优先清理，默认 500 MB',
        },
        {
          field: 'enable_typing',
          label: '正在输入',
          component: 'Switch',
          bottomHelpMessage: '预留的正在输入状态开关',
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
          setConfigValue(config, keyPath, value)
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

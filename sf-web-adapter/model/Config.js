import makeConfig from "../../../lib/plugins/config.js"

export const { config, configSave } = await makeConfig("SFWebAdapter", {
  tips: "Web 适配器配置\n修改后需重启插件生效",
  // WebSocket 服务配置
  ws_host: "0.0.0.0",
  ws_port: 8082,
  access_password: "",
  site_title: "云崽 Web 对话",
  // 历史和消息配置
  history_max: 500,
  max_image_size: 5242880,
  enable_typing: true,
  // 媒体缓存配置（图片/语音落盘，供前端离线后回看）
  media_retention_days: 14,
  media_max_size_mb: 500,
  debug: false,
}, {
  tips: [
    "欢迎使用 TRSS-Yunzai Web 适配器插件!",
    "前端 UI 已拆分到独立仓库: https://github.com/eggacheb/sf-web-trss-web",
    "使用 #web状态 查看 WebSocket 服务状态",
  ],
})

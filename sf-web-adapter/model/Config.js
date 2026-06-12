import makeConfig from "../../../lib/plugins/config.js"

export const { config, configSave } = await makeConfig("SFWebAdapter", {
  tips: "Web 适配器配置\n修改后需重启插件生效",
  ws_host: "0.0.0.0",
  ws_port: 8081,
  access_password: "",
  site_title: "云崽 Web 对话",
  history_max: 100,
  max_image_size: 5242880,
  enable_typing: true,
  debug: false,
})

# app/ — 内嵌排盘应用

这是 dsh-ziwei 插件内嵌的 Next.js 应用，由 `dsh-ziwei-app.service` 在
`127.0.0.1:8815` 上以 `/ziwei` 为 basePath 运行，插件 host 半反代给已登录的 DSH 会话。

- 插件本体（侧栏入口、`/ziwei/ai`、`/ziwei/birth`、鉴权）见上一级目录与 `../docs/`。
- 路由与组件地图见 `../docs/app-map.md`；接口见 `../docs/api.md`；部署见 `../docs/deploy.md`。
- 排盘引擎与古籍数据来自开源项目 ziwei-doushu（MIT，见 `LICENSE`）；界面已按插件形态重做，
  不再包含该项目的落地页、会员/隐私条款、数据集与 CI 脚手架。
- 改代码：`npm run typecheck` → `npm run build` → `systemctl restart dsh-ziwei-app.service`。
- 回归：`npm test`（排盘内核 10 组）与 `node test-persistence.mjs --help`（生辰持久化，需带 token 的实例地址）。

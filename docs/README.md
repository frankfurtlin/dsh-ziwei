# dsh-ziwei 文档索引

紫微斗数从「独立的 Next.js 网站」改造成「DSH 插件 + 内嵌应用」之后的全部文档。
一句话定位：**排盘应用只在本机跑（127.0.0.1:8815），DSH 插件把它嵌进侧栏面板，解读走 DSH 的模型**。

| 文档 | 读它来解决什么问题 |
| --- | --- |
| [architecture.md](./architecture.md) | 整体是怎么搭起来的：两层结构、请求链路、鉴权在哪、数据存在哪 |
| [api.md](./api.md) | host 半提供的三个入口（反代 / AI / 生辰）的协议、事件格式、错误码，含 curl 示例 |
| [app-map.md](./app-map.md) | 排盘应用里都有什么：路由表、组件职责、`lib/ziwei` 每个模块干什么、哪些删了、怎么跑回归测试 |
| [deploy.md](./deploy.md) | 服务单元、端口、构建与重启、改什么要重启什么、验收命令、回滚、故障排查 |
| [changelog.md](./changelog.md) | 从独立站点到插件版的完整演进记录，以及每一轮踩过的坑 |

## 30 秒速览

```text
浏览器 ──https──> Caddy ──> dsh-passwords(3081) ──> DSH(3080) ──┬─ 侧栏「紫微斗数」面板
                                                                 └─ /ziwei/* 前缀路由（插件 host 半）
                                                                      ├─ /ziwei/ai    → ctx.llm.stream() 流式解读
                                                                      ├─ /ziwei/birth → ~/.dsh/ziwei/birth.json
                                                                      └─ 其它         → 反代 127.0.0.1:8815（Next.js 排盘应用）
```

- 插件源码：`plugins/dsh-ziwei/`（本仓库），host 半在 `lib/`，client 半在 `client.js`，应用在 `app/`。
- 应用源码：本仓库 `app/`（原 `workspace/ziwei-doushu`，已整体搬入，工作区里不再有第二份）。
- 服务单元：`dsh-ziwei-app.service`（跑 `app/`，监听 `127.0.0.1:8815`）。
- 验收：`node verify.mjs --url "<带 token 的 DSH 地址>" --out verification/prod --ask`（38 项）。
- 生辰回归：`node app/test-persistence.mjs --url http://127.0.0.1:8815/ziwei/chart`（16 项，不需要 DSH token）。

## 改代码前先看这三条

1. **宿主半 / 客户端半的生效方式不同**：`client.js` 每次页面加载都从磁盘重新拼进
   `/plugins/??…` 束，改完刷新页面就生效；`lib/*.js` 是宿主插件，必须重启
   `deepseek-harness.service`（重启会杀掉当前对话轮次，用 `systemd-run --on-active=…` 脱离会话）。
2. **应用改动要走构建**：`cd app && npm run build && systemctl restart dsh-ziwei-app.service`。
   只改代码不重启，iframe 里还是旧的。
3. **不要为了让验收通过而放宽断言**：verify.mjs 里每条断言都对应一个真实用户动作
   （点开抽屉、点一颗星、点分享、切 tab），历史上它抓出过「按钮被宠物浮层挡住」「模型只想不说」
   这类真 bug。

# 架构

## 一句话

DSH 插件（`dsh-ziwei`）在宿主里注册一个侧栏面板 + 一个 `/ziwei` 前缀路由；
面板里用同源 iframe 嵌本机的 Next.js 排盘应用；路由把请求反代给应用，
但 `/ziwei/ai`（模型解读）和 `/ziwei/birth`（生辰配置）由插件自己处理。
**应用本身不暴露公网，解读不再需要第二份 API Key。**

## 两层结构

```text
┌─ DSH 宿主进程（node dsh --profile web，127.0.0.1:3080）────────────────┐
│                                                                        │
│  client 半（浏览器）        client.js                                  │
│    ├─ slots 注册 sidebar.panellist（order 20）→ 侧栏「紫微斗数」        │
│    └─ slots 注册 main(key=ziwei)  → 面板页：四个视图 + iframe + 工具条  │
│                                                                        │
│  host 半（node）            lib/index.js                               │
│    ├─ webServer.register({kind:'prefix', path:'/ziwei'})               │
│    ├─ /ziwei/birth        → lib/birth-store.js（读写 birth.json）      │
│    ├─ /ziwei/ai           → lib/ai.js（ctx.llm.stream 流式 SSE）        │
│    └─ 其它 /ziwei/*        → http 反代 127.0.0.1:8815                  │
└────────────────────────────────────────────────────────────────────────┘
                    │ 反代（同源、带 cookie、流式）
                    ▼
┌─ dsh-ziwei-app.service（Next.js 16，app/，127.0.0.1:8815）─────────────┐
│  /ziwei/chart     排盘页（本命/大限/流年、概览抽屉、点星、分享）        │
│  /ziwei/heming    合盘     /ziwei/library 古籍     /ziwei/knowledge 百科│
│  /ziwei/          落地页   /ziwei/preview 开场动画                      │
└────────────────────────────────────────────────────────────────────────┘
```

为什么分成两层而不是把应用塞进插件：

- 应用是 Next.js（有 SSR、静态资源、构建产物），塞进插件包会拖慢宿主启动，
  也让每次改样式都要重启 DSH；
- 分层后应用可以独立 `npm run build` / `systemctl restart dsh-ziwei-app`，
  插件侧只有「一条反代 + 两个小接口」，改动面小、风险低；
- 隔离端口与进程，应用崩了不会拖死 DSH，面板里会显示 502 的友好提示。

## 请求链路与鉴权

公网访问路径：`浏览器 → Caddy(443) → dsh-passwords(3081 登录网关) → DSH(3080) → 插件`。

插件注册的路由**默认不鉴权**，所以 `lib/index.js` 每个请求先调：

```js
ctx.get('connection', false)?.requestRejection(req)   // 403 不可信 Host/Origin，401 未登录，undefined 放行
```

- 未登录：`/ziwei/` 返回 **401**（浏览器直接看是 `dsh web authentication required`）；
- 带登录 cookie：正常 200，iframe 里的相对路径请求自动带 cookie，所以应用内的
  `fetch('/ziwei/birth')` 天然通过；
- 公网 `hermes.frankfurtlin.top/ziwei/` 已经**摘掉**（Caddy 里那段 `handle /ziwei*`
  改成注释保留），未登录访问 404；`dsh.frankfurtlin.top/ziwei/` 走登录网关，未登录 302。

## 三个入口的分工

| 路径 | 谁处理 | 说明 |
| --- | --- | --- |
| `/ziwei/ai` | `lib/ai.js` | POST，SSE 流式；用宿主当前模型（`agentDefaultModel.currentSelection()`） |
| `/ziwei/birth` | `lib/birth-store.js` | GET/POST/DELETE，读写 `$DSH_HOME/ziwei/birth.json`（0600） |
| 其它 `/ziwei/*` | 反代 → `127.0.0.1:8815` | 剥 hop-by-hop 头，补 `x-forwarded-*`，上游挂了回 502 |

## 数据存在哪

| 数据 | 位置 | 权限 | 谁写 |
| --- | --- | --- | --- |
| 生辰（当前 + 最近 20 条历史） | `~/.dsh/ziwei/birth.json` | 0600 | `lib/birth-store.js` |
| 模型凭据 | `~/.dsh/.credentials.yaml`（DSH 自己的） | 0600 | DSH；插件不碰 |
| 面板视图/主题偏好 | 只在前端内存，不落盘 | — | — |
| 验收截图与报告 | `verification/`（gitignore） | — | `verify.mjs` |

旧的浏览器 `localStorage` 记录（键 `ziwei-birth-v1`）在页面加载时会被顺手删掉，
不需要手动清理。

## 前端面板结构（client 半）

- **侧栏行**：`sidebar.panellist`，`id=ziwei`、`order=20` —— 夹在
  `Automation tasks`（order 10）和 `Skill Center`（order 30）之间。
- **主面板**：`main` 座位，keyed=`ziwei`，内容自上而下三段：
  1. 工具条：标题 + 分段控件（排盘/合盘/古籍/百科）+ 状态文案 + 提问框 +
     「让 DSH 解读」「刷新」「新窗口打开」；
  2. iframe（同源，`src=/ziwei/<view>?theme=<宿主主题>`）；
  3. 与 iframe 的双向消息：`dsh-ziwei:chart`（盘面摘要上行，用于「让 DSH 解读」）、
     `dsh-ziwei:theme`（宿主主题下行）、`dsh-ziwei:insets`（宠物遮挡区域下行）。
- **宠物让位**：每 2 秒量一次 dsh-pet 浮层与 iframe 的交集，把 `bottom/right`
  发给内嵌页，内嵌页据此给底部输入区留白——这样「追问」按钮永远点得到。

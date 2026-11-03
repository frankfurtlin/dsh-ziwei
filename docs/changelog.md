# 变更记录

这个插件不是一次写成的：一个跑在公网上的独立站点，被拆成「本机应用 + DSH 插件」，
中间每一步都是被具体问题推着走的。下面按时间顺序记，重点是**每一步为什么改、踩了什么坑**。

时间都在 2026-11-03（如无特别标注）。

---

## 0. 起点：独立站点

`workspace/ziwei-doushu` 是一个 Next.js 16 应用：`basePath=/ziwei`，
`ziwei-doushu.service` 跑在 `127.0.0.1:8815`，Caddy 上有 `handle /ziwei* { reverse_proxy 127.0.0.1:8815 }`
把它暴露到 `hermes.frankfurtlin.top/ziwei/`。它自带一套 AI 解读
（`/api/interpret` + 自己的 `AI_*` 环境变量 + 每日限额），排盘内核在 `lib/ziwei/*`（约 5300 行，基于 `iztro`）。

## 1. 做成 DSH 插件（需求：侧栏入口 + 不暴露公网）

目标：侧栏「插件」组里，Automation tasks 下面多一行「紫微斗数」，点开是主页面，
能接 DSH 的 AI，同时撤掉公网入口。

做法：
- 新建 `plugins/dsh-ziwei`：`package.json` + `cordis.patch.yml` + `lib/index.js`（host 半）+
  `client.js`（client 半）。
- host 半注册 `prefix /ziwei` 反代到 8815，每个请求先过
  `ctx.connection.requestRejection(req)`（403 不可信 Host/Origin、401 未登录），
  **不自己造鉴权**，直接继承 DSH 登录态。
- client 半用 `window.__ModuleLoader__.load` 手写工厂（不打包、不用 JSX），
  注册 `sidebar.panellist`（`order: 20`，插在 Automation tasks 10 与 Skill Center 30 之间）
  和 `main` keyed 座位，面板里放同源 iframe。
- 撤掉 Caddy 的 `/ziwei` 路由（`caddy validate` + `systemctl restart caddy`；
  全局 admin off，reload 必失败）。

坑：
- 侧栏是 `slots` 座位机制，`Icon({size})` 必须返回带 `data-dsh-panel-entry` 的 `svg`，
  否则侧栏一行渲染不出来；
- 宿主对 `/` 有登录闸门、对未知路径 404，但**插件自己注册的路由默认不鉴权**，必须每题调 `requestRejection`；
- 改 client 半之后发现页面没变——一开始误判成「必须重启宿主」，后来确认
  **`link:` 插件的 `client.js` 每次请求都从磁盘重新拼进 `/plugins/??…` 束，刷新即生效**，
  之前是浏览器缓存导致的假象。只有 `lib/*.js`（host 半）才需要重启。

## 2. 浅色主题（需求：跟主站默认白色一致）

应用本来就有双主题（`:root` 浅色 + `[data-theme="dark"]`），问题是 `app/layout.tsx` 首屏脚本
默认写死 `dark`，而且命盘用的 `--t-*` 变量**全仓库没定义**（暗色下靠继承 body 颜色，
浅色下就发飘）。

- 首屏脚本优先级改成：URL `?theme=` → localStorage → **默认 light**；
- 补齐 `--t-bg/--t-card/--t-surface/--t-text/--t-text1/--t-text2/--t-faint/--t-border/--t-border-acc/--t-gold`、
  `--star-*`、`--board-shadow` 的浅色取值，并给白底压深一层 `.text-amber-*` 之类的覆盖；
- 插件侧把 `?theme=<外壳配色>` 拼进 iframe URL，外壳切主题时用
  `postMessage({type:'dsh-ziwei:theme'})` 推送（只换主题、不重载，盘面不丢）。

## 3. 删掉应用自带的 AI 面板（需求：既然是插件就用 DSH 的能力）

删 `InsightPanel` / `ChatPanel` / `app/api/interpret`，排盘页改单栏。顺带删掉页面外层重复的
`TimeNav`（`ChartBoard` 内部自带且真的控制大限/流年，外层那个是死 UI）。

坑：删了 route 以后不 `rm -rf .next` 就 build 会报 `TS2307`（`.next/types/validator.ts` 还指向旧 route）。

## 4. 解读面板加回来，但用 DSH 的模型

用户反馈「自带面板给我的东西看不懂」，所以要面板，但内容必须由 DSH 的模型生成。

- host 半新增 `POST /ziwei/ai`：`ctx.llm.stream()` + SSE，用宿主当前默认模型
  （`agentDefaultModel.currentSelection()`），不需要第二把 key；
- 应用侧重写 `InsightPanel`：六 tab、SSE 流式、`RichText` 极简渲染、底部追问框；
- 盘面摘要由新增的 `lib/ziwei/digest.ts` 压成纯文本随请求带上。

坑（全是真 bug，每个都让面板白屏或空白过）：
1. **`MissingSessionID`**：opencode 路由要求 `x-opencode-session`，而 pi-ai 适配器只有在
   `options.sessionId !== undefined` 时才透传。解法：页面级 uuid 放 `x-ziwei-thread` 头，
   host 校验后作为 `sessionId`。
2. **`replayState` TypeError**：历史里的 assistant 消息不带 `source` 时，
   `toPiAssistant()` 读 `message.source.replayState` 直接崩。解法：`buildMessages` 补
   `source: { kind: 'model', provider, model }`。
3. **只想不说**：`reasoningEffort: high` 时 90 秒只有 reasoning-delta；把思考压到 `low`
   并把 reasoning 计数转成「模型正在思考…（已思考 N 字）」提示。
   更隐蔽的是**思考吃输出预算**：`maxTokens=1600` 被推演吃光，正文一个字没有。
   现在首轮 2600，无正文就带「直接输出正文」提示放大到 6000 重试一次。
4. **追问按钮点不动**：被 dsh-pet 固定浮层盖住（`elementFromPoint` 命中的是宠物），
   而 Playwright 的 `force: true` 会把事件派给最上层元素，**测试反而看不到这个 bug**。
   面板先缩短高度避开，后来改成动态测量（见第 6 节）。

## 5. 生辰记忆：先 localStorage，再服务端配置

第一版按用户「可以接受 localstorage」实现（`lib/birth-storage.ts`，键 `ziwei-birth-v1`）。

随后用户要求「记录到配置文件中，服务端存储」，于是：
- host 半新增 `lib/birth-store.js` + `/ziwei/birth`（GET/POST/DELETE），
  落盘 `$DSH_HOME/ziwei/birth.json`，`0600`，临时文件 + rename；
- 应用侧 `birth-storage.ts` 改成 fetch 同源接口，加载时顺手删掉旧 localStorage 键；
- `current` 用于自动恢复盘面，`history` 保留最近 20 条不同生辰；
- 恢复盘面时**不**自动调模型（省一次调用），只有手动起盘那轮才自动生成总览。

坑：验收脚本会把用户真实生辰冲掉——现在两个脚本都先 GET 快照、结束时 POST 还原。

## 6. 版面撑满 + 宠物让位

用户：「内容区域下面还有很多高度，利用起来」。改成 `main { height:100vh }` 的 flex 列、
盘面 `flex:1`、4×4 网格行高 `1fr`，右栏也整列满高。

撑满之后「追问」按钮又落回右下角被宠物盖住，于是改成**动态测量**：
插件每 2s 量宠物与 iframe 的交集，`postMessage({type:'dsh-ziwei:insets', bottom, right})`
给内嵌页，输入区按量出来的矩形让位（`<main data-pet-insets="bottom,right">` 供断言）。
不写死留白，是因为宠物位置/大小在不同视口下会变。

## 7. 接回丢掉的零件（需求：都做一下，做完自测）

插件版早期为了快，把应用里几块「孤儿子组件」丢在了仓库里没接回来。这次补齐：

| 零件 | 处理 |
| --- | --- |
| `ChartSummary`（命格总览 + 本命四化 + 格局识别） | 接到命盘页的**概览抽屉**（展开才占高度） |
| `PatternsCard` | **删除**：内容与 ChartSummary 里的「格局识别」完全重复 |
| `StarDetailPanel`（点星看解释） | 接回：点任意星弹出，实心底色卡片 |
| `ShareModal` + `ShareCardCanvas`（分享图/链接） | 接回：html2canvas 现场生成 PNG + 带生辰参数的短链 |
| `FamousPersonCard` | **删除**：依赖 server-only 的名人数据，且没有任何入口 |

根因：`lib/ziwei/patterns.ts` 顶上有一句 `import 'server-only'`，ChartSummary 是客户端组件，
所以当年编译不过就被搁置成了死代码。那句 import 已删（纯计算，没有秘密）。

自测抓出来的问题：分享卡其实没有 `<canvas>`（canvas 只在点下载时才由 html2canvas 生成，
断言要改成等真实下载事件）；概览抽屉截图空白是 framer-motion 入场动画没跑完；
`npm run build` 与文件编辑撞车会打出旧代码（症状是新加的 `data-*` 锚点在 DOM 里查不到）。

## 8. 面板四个视图（排盘 / 合盘 / 古籍 / 百科）

应用里本来就有 `/ziwei/heming`、`/ziwei/library`、`/ziwei/knowledge`，只是插件固定落 `/ziwei/chart`。
面板工具条加了分段控件 `VIEWS`，切视图重建 iframe 并清掉上一张盘摘要
（否则「让 DSH 解读」可能拿到上一张盘的文本）。锚点：
`data-dsh-ziwei-tab` / `data-dsh-ziwei-frame`。

## 9. 应用收进插件仓库，删掉旧目录

原先插件只是反代 `workspace/ziwei-doushu`，所以「只留插件版本」不能直接删目录（会 502）。
顺序是：

1. `systemctl stop ziwei-doushu.service` → `mv workspace/ziwei-doushu plugins/dsh-ziwei/app`；
2. 新建 `dsh-ziwei-app.service`（`WorkingDirectory=…/app`，其余与旧单元一致），`enable --now`；
3. 删旧单元 `ziwei-doushu.service`（disable + rm + daemon-reload）；
4. 清掉两个死文件：`app/caddy.new`（nginx→Caddy 迁移遗留）、`app/.ai-usage.json`（旧内置 AI 的用量）；
5. 补 `.gitignore`（`app/node_modules`、`app/.next`、`.env*` 等），提交 `5b2b83f`。

搬迁后没有重新 build 就能跑（`.next` 是相对路径产物），`/ziwei/{chart,heming,library,knowledge}` 全 200。

## 10. 补文档（本次）

新增 `docs/`：`README`（索引 + 速览 + 改代码前必看）、`architecture`（两层结构与鉴权）、
`api`（三个入口协议与错误码）、`app-map`（应用能力地图）、`deploy`（单元/构建/验收/回滚/排障）、
本文件（演进与踩坑）。同时把 README 里指向旧路径 `/root/workspace/ziwei-doushu` 的说法、
`restart-and-verify.sh` 里的 test-persistence 路径、502 文案里的 systemd 单元名一并修正。

## 11. 修「百科点进去 404」

用户反馈：面板「百科」里点任意一张星曜卡片，进去是 404。

根因不在我们这几轮的改动，而在开源版的设定：`app/lib/ziwei/db-analysis.ts` 是占位文件，
`STAR_DB`（14 主星 × 13 宫位的逐宫论断内容库）置空，于是
`getAllKnowledgeRoutes()` 返回 **0 条**；而 `app/knowledge/[star]/[topic]/page.tsx` 顶上写着
`export const dynamicParams = false`，配合 `if (!data.exists) notFound()`，
结果是 14×13 = 182 个详情 URL 全部 404 —— 列表页有卡片、点进去必死。

改法（不改数据、不编内容）：

- `dynamicParams = false` → `true`：允许运行时渲染这些参数；
- `if (!data.exists) notFound()` → 改为渲染一页说明：「这一版是开源排盘引擎，安星/四化/格局/古籍原典都开放，
  但逐宫论断内容库不在开源范围，所以这一页没有正文」，并给出两个替代入口（古籍原典库、起盘后让 DSH 的模型解读）；
- 缺内容时 `generateMetadata` 返回正经标题并标 `robots: noindex, nofollow`，空壳页不进搜索引擎；
  正文为空时也不再输出空的 JSON-LD `Article`；
- 顺带修掉「命宫宫」：`TOPIC_PALACE_NAME` 里命宫自带「宫」字，其他是「夫妻」「官禄」，
  统一用 `withPalace()` 补一次，标题/面包屑/内链都不再重复。

自测：面板 → 百科 → 点卡片 → 详情页 200、显示说明与替代入口 → 面包屑回列表，10/10 通过；
`/ziwei/knowledge/{ziwei/overview,tianji/love,pojun/career}` 全部 200。

---

## 提交记录

```text
29c6416 chore: 初始化 dsh-ziwei 插件仓库
7c30ebd docs: 记录提交信息约定
c00ce95 feat(panel): 增加排盘/合盘/古籍/百科四个二级入口
30e4762 test(verify): 补上概览/点星/分享/视图切换的验收断言
5b2b83f feat(app): 把排盘应用收进插件仓库（app/）
a01c47f docs: 补齐插件文档（架构/接口/能力地图/部署/变更记录）
c61500d fix(host): 502 文案与验收脚本指向搬移后的应用
```

约定见 README「提交约定」：Conventional Commits + 中文摘要，一次提交只做一件事。

## 当前验收基线

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `verify.mjs`（`--ask`） | 38 | 侧栏入口与顺序、鉴权 401、面板与四视图、起盘、配色、版面撑满、宠物让位、生辰服务端存储、解读面板（自动生成/切 tab/追问）、概览抽屉、点星详情、分享卡与分享链接、「让 DSH 解读」建会话 + 草稿 + 剪贴板、无 console 报错 |
| `app/test-persistence.mjs` | 16 | 清空 → 起盘写配置 → 重载恢复 → 换浏览器上下文恢复 → 重新起盘回填 → 忘记清空 → 还原原记录 |
| `app/npm test` | 10 | 排盘内核回归（盘面完整性、DST、节气边界、红鸾天喜、双四化、命名中立性…） |

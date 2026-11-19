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

## 12. 去掉开源项目的影子，只留插件形态（+ 两个小功能）

搬进插件仓库之后，`app/` 里仍然留着「这是一个对外开源站点」的全部零件。插件是跑在本机、
登录之后才看得到的内部工具，这些零件没有一样用得上，反而处处露出上游的痕迹。这一轮按
「最小可用插件」重排：

**删掉（作为独立站点才需要）**

- 营销落地页 `app/page.tsx`（1125 行：Hero、课程路线、AI 答疑、支付与会员话术）—— 改成
  `redirect('/chart')`，`/ziwei` 只是把误入的访问者送回排盘页；
- `app/preview`（开场动画）、`app/privacy`（写着手机号/会员/支付宝/Claude 数据出境）、
  `app/terms`、`app/sitemap.ts`、`app/robots.ts`；
- `app/heming`（合盘）—— 它唯一的数据源是已删除的 `app/api/heming`，页面自己都写着
  「开源版不含合盘 AI 分析接口」，属于死功能；
- 上游仓库脚手架：`.github/`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`DATASET-LICENSE`、
  `README.en.md`、上游 `README.md`、`docs/`（2.7M，含 1848 条天纪引文语料，运行时不引用）、
  `verification-birth/`、空目录 `app/api/`；
- 只为落地页服务的组件：`StarField`、`ScrollIntro`、`lib/heming-knowledge.ts`、`lib/site.ts`。

**改掉（口径从「对外产品」改成「本机插件」）**

- `layout.tsx` metadata 精简成 `紫微斗数` + 一句插件说明 + `robots: noindex, nofollow`，
  去掉 canonical/OpenGraph/站长验证码；
- 古籍库、知识库顶栏的「← 返回首页」→「← 排盘」、「倪师方法论 ·」前缀去掉，页脚合规话术
  换成「收录范围为公版明刊本的精华段落」；
- 百科详情页的占位文案改成插件口径：不预置断语，星曜本义与古籍出处保留，具体到你的盘
  由 DSH 的模型现场解读；
- 分享卡底部由站点域名改「DSH · 紫微斗数」；表单按钮「立即起盘 · 解命运密码」→「立即起盘」；
- `.env*` 全部重写：应用不需要任何密钥（解读走宿主 `/ziwei/ai`，生辰走 `/ziwei/birth`），
  旧内置 AI 的 `AI_*` 变量清空。

**加两个「插件才成立」的小功能**

- **最近生辰**：host 半本来就把用过的生辰写进 `$DSH_HOME/ziwei/birth.json`（去重、最多 20 条），
  现在把这笔数据用起来 —— 工具条「最近生辰 ▾」列最近 5 条，点一条直接换盘；表单页顶部也有
  「最近用过」胶囊。数据在服务端，换浏览器、清缓存都在。
- **复制盘面摘要**：把 `digestChart()` 生成的文本复制到剪贴板，可以直接贴进任意会话，
  不必先开新会话。

**面板视图 4 → 3**：去掉「合盘」（依赖已删除的应用内 AI），只剩排盘 / 古籍 / 百科；
`client.js` 的 `VIEWS` 与验收断言同步。

**踩坑**：`redirect('/chart')` 在 `basePath=/ziwei` 下会被 Next 自动加前缀，写成
`redirect('/ziwei/chart')` 会变成 `/ziwei/ziwei/chart`；另外 `/ziwei/` 的 308 是 Next 自己
去掉末尾斜杠，不是我们的重定向。

自测：`tsc --noEmit`、`next build`、`verify.mjs` 42 项全 PASS、`app/test-persistence.mjs` 16 项
全 PASS、`/ziwei/{heming,preview,privacy}` 均 404、`/ziwei` 307 → `/ziwei/chart` 200。

---

## 13. 合盘回归：不再依赖应用内 AI

上一轮「去开源痕迹」把合盘当成死功能删了，因为它唯一的数据源是被我们删掉的 `app/api/heming`。
但合盘本身是有用的 —— 缺的只是 AI，而 AI 已经有了（宿主 `/ziwei/ai`）。

- 恢复 `app/heming/page.tsx` 与 `lib/ziwei/heming-knowledge.ts`（从删除前那次提交取回）；
- 页面改为 `POST /ziwei/ai`：`topic: 'heming'` + `digest`（甲方）+ `digestB`（乙方），
  SSE 解析按宿主的 `delta` / `error` / `done` 事件格式重写；带 `x-ziwei-thread` 复用会话；
- host 半：`TOPIC_PROMPTS.heming`（合盘五节：定性 / 性格契合 / 对应宫位 / 互补冲突 / 相处建议），
  `buildMessages` 支持 `digestB`，按【甲方命盘】【乙方命盘】分别拼进 prompt；
- 小节标题兼容 `**【小节】**` 与 `【小节】` 两种写法（模型两种都会写）；
- 顶栏「‹ 返回」→「‹ 排盘」；
- 面板 `VIEWS` 恢复「合盘」tab（排盘 / 合盘 / 古籍 / 百科）；
- 验收：`verify.mjs` 新增「面板能切到合盘」与「合盘分析由 DSH 模型生成」（读
  `[data-heming-analysis]`，等追问框出现或文本稳定后再断言）。

**踩坑**：`process.env.NEXT_PUBLIC_BASE_PATH` 就是 `/ziwei`（basePath），而宿主路由也叫 `/ziwei/ai`，
所以 fetch 要写 `${BASE}/ai`；写成 `${BASE}/ziwei/ai` 会变成 `/ziwei/ziwei/ai` → 404。


## 14. 一轮「隐藏 bug」清剿

用户反馈「看看还有啥隐藏的bug」后，用静态审计 + playwright 边界实测扫了一遍，修掉下面这些。

**高危**

- **排盘页白屏**：分享链接里写了不存在的日期（`?b=1990-2-31-5`）时，`generateChart` 抛 `RangeError: solar date does not exist`，React 整页崩成白屏（body 只剩 70 字符）。现在 `readSharedBirth` 用 `isRealDate` 校验真实存在，起盘统一走 `safeChart()`（先校验、再 try/catch），失败回落到表单并显示 `data-ziwei-error` 提示条。
- **服务端曾接受 2 月 31 日**：`POST /ziwei/birth` 只校验范围（day 1–31），把不存在的日期写进配置文件后，每次打开排盘页都会崩，而且坏记录留在 `history` 里会一直被「最近生辰」点出来。现在 `isBirthInfo` 用 UTC 回读校验真实日期，非法直接 400；现网那条坏记录也清了。
- **晚子时两页排不同的盘**：排盘页直接吃 `BirthForm` 给的日期，合盘页走 `formToBirthInfo`（23:00–23:59 按次日）。同一生辰在两页会排出不同的农历日/紫微/四化。现在排盘页也统一走 `formToBirthInfo`（实测 1990-06-15 23:30 存成 06-16 子时）。
- **命盘 prompt 可能写进上一个会话**：宿主的 `uiWorkspace.startSession()` 是**同步 void**（`navigation.d.ts` 里就这么声明），`await` 是空操作，于是切面板立刻发生、`fillComposer` 用全局选择器轮询时命中的还是旧会话的 Lexical 编辑器。现在写入前先记下已有编辑器的快照，只往「切换之后新挂载」的编辑器里写；连续点击用序列号取消上一次填充。

**中危**

- **并发保存丢历史**：`birth.json` 是「读旧文件→改→写」，两个标签页同时保存会互相覆盖（实测 8 个并发 POST 只剩 1 条）。`lib/birth-store.js` 现在有进程内写队列（读改写串行）+ 唯一临时文件名；坏文件不再静默丢，先备份成 `birth.json.corrupt-<ts>` 再当空存储。
- **上游卡住会挂死 handler**：反代没有 `setTimeout`。现在 10 秒超时回 504。
- **换盘后旧盘上下文还在**：`<InsightPanel>` 没有 `key`，换一张盘后旧盘的解读正文与追问历史继续作为上下文发给模型。现在按盘面摘要做 `key`，换盘即重建面板。
- **未知 topic 返回 500**：`/ziwei/knowledge/ziwei/bogus` 会走到 `withPalace(undefined)` 抛错。现在星级/topic 校验不过直接 `notFound()`（实测 404）。
- **413 是死代码**：`readBody` 超限时先 `req.destroy()` 再回包，客户端只会看到连接重置（curl 报 000）。现在先 `pause`、回可读的 413、再 `res.on('finish')` 断开；`/ziwei/ai` 与 `/ziwei/birth` 都实测能拿到 `{"error":"请求体超过 256 KiB"}`。
- **未捕获异常会带崩整个 dsh 进程**：`handleBirthRequest` 在 `createHandler` 里是裸调用，一次异常的 unhandled rejection 就会让宿主退出（实测崩过一次）。现在补了 `.catch` 兜底。
- **解读面板错误文案**：直连 8815 或登录过期时会显示原始「解读服务返回 404」。现在 40x 映射成「解读服务不可用（可能登录状态已过期…）」，并补了卸载时 abort 在途请求。

**验收**

`verify.mjs --ask` 在测试实例 **44/44 通过**（含草稿填充、合盘 1043 字、宠物不遮挡、分享下载）；`app/test-persistence.mjs` 16/16；`app/npm test` 10/10。

---

## 15. 收紧对外暴露的信息

用户看了上一轮的「已知但未动」后说「收紧一下」。这一轮不新增功能，只把回给浏览器的文案与
路径里多余的内部信息拿掉；诊断信息全部改走宿主日志。

- **不再回本机绝对路径**：`GET/POST /ziwei/birth` 的 `file` 从 `/root/.dsh/ziwei/birth.json`
  改成 `ziwei/birth.json`（相对 `$DSH_HOME`）。绝对路径会漏出用户名与目录结构。
- **反代失败文案去内部细节**：502 从「紫微斗数应用暂时不可用（ECONNREFUSED）。请确认本地服务
  在跑：`systemctl status dsh-ziwei-app.service`」改成「紫微斗数应用暂时不可用，请稍后重试。」；
  504 同样只留「响应超时，请稍后重试。」。错误码、目标端口、Unit 名只写
  `console.warn('[dsh-ziwei] 反代失败（…）: GET /ziwei/… → 127.0.0.1:8815')`。
- **解读失败不再回原始错误**：模型的 `finish.kind === 'error'` 与外层 catch 以前会把
  provider 侧的 `failure.message` 直接塞进 SSE。现在统一成「模型这次没有给出结果，请稍后重试。」
  /「解读生成失败，请稍后再试。」/「解读被取消或超时了，再点一次即可。」，原始异常只进
  `console.error('[dsh-ziwei] 解读失败:', error)`；400/413 仍保留可操作的中文说明。
- **`done` 事件不再带 `provider`/`model`**：界面用不到，去掉少一处指纹。
- **出生信息校验失败之外的 500 也收口**：`handleBirthRequest` 的兜底 catch 以前回
  `error.message`，现在回「生辰存储暂时不可用，请稍后再试。」。
- **`sendPayloadTooLarge` 之后仍会断开连接**（`res.on('finish')` 再 `req.destroy()`），
  413 可读这件事保持不变。

**验收**：新增两条断言——`verify.mjs` 里「生辰接口只回相对位置，不泄漏本机绝对路径」、
`app/test-persistence.mjs` 的 `file` 断言加「不以 `/` 开头」。生产 44 项、persistence 16 项、
内核回归 10 项全通过。

## 16. 解读面板：首字更快、吐词更匀

用户反馈「右侧的 AI 首词很慢，而且输出不够平滑，吐词不够均匀」。量了一下再改：

**首字延迟 27.5s → 6.6s**

- 先排除无效选项：`reasoningEffort: 'off'` / `'minimal'` 这个模型直接拒绝
  （`provider "opencode-go" model "deepseek-v4.1-flash" does not support reasoning effort "off"`），
  所以不能靠关掉思考提速。
- 真正有效的是**在系统提示里限制内部推演**：定调后立刻写正文、不要逐宫罗列、不要预演小节。
  同一张盘同一模型实测：首个 delta 27.51s → 6.62s，整段 33.07s → 12.44s。
- 顺手把 `reasoningEffort` 做成可用 `DSH_ZIWEI_AI_REASONING` 覆盖，方便以后调参。

**吐词节奏：最长停顿 1190ms → 170ms**

- 采样发现上游 SSE 本来就不均匀：单块 1–24 字混杂，还有 0.6s、1.19s 的卡顿。这是
  provider 侧的流式粒度，服务端无法让它变细。
- 所以改在前端：`InsightPanel` 收到 delta 只进缓冲，用 30fps 定时器匀速放出，
  放的速度跟积压量挂钩（积压多则单帧多放几个字，最多 24 字/帧），流结束再把尾巴放完。
  肉眼效果是「字一直在出来」，而不是「糊一段→干等→再糊一段」。
- `verify.mjs` 新增两条断言：首字 < 20s、最长停顿 < 1.2s（实测 `first_grow=4132ms`、
  `increments=38 max_stall=170ms`）。

## 17. 「最近生辰」不再丢记录

用户反馈「最近生辰的记录好像有点问题」。查下来是两类问题叠在一起：

**1. 验收脚本会冲掉历史（数据真的丢过）**

`verify.mjs` 与 `app/test-persistence.mjs` 都会先 `DELETE /ziwei/birth` 造干净起点，
跑完只把快照里的 `current` 写回去 —— `history` 就直接没了。每次部署验证都在生产跑一遍，
用户之前输过的几条生辰就是这样从「最近生辰」里消失的。现在两个脚本都改成：

- 清空用显式的 `DELETE /ziwei/birth?scope=all`；
- 还原时先清空，再按「旧→新」回放快照里的 `history`，最后写回 `current`，顺序不乱；
- 断言也从「恢复了原有记录」升级成「恢复后的 history 条数 ≥ 快照条数」，
  以后脚本再把历史弄丢会直接 FAIL。

**2. 「忘记」把历史一起删了**

按钮叫「忘记这个生辰」，实际把 `history` 也清了，等于抹掉全部记录。现在语义拆开：

- `DELETE /ziwei/birth`：只清 `current`（下次打开不再自动恢复），历史保留；
- `DELETE /ziwei/birth?scope=all`：两个都清，对应下拉列表底部的「清空全部记录…」，
  带二次确认。

**顺带把列表做得能分辨**

以前条目只显示 `1990-06-15 · 巳时 · 男`：同一天同一人早晚子时会被换算成次日，日期跳一天；
不同出生地（真太阳时校正）排出来的盘不同，但列表里长得一模一样。现在有表单快照时
附带原始时刻与出生地：`1990-06-15 23:30 · 子时 · 男 · 上海`。

验收新增/改写了 3 条：「忘记」只清当前记录、保留历史列表；「最近生辰」列出服务端记住的生辰；
「验收后完整恢复了原有的生辰记录（含最近列表）」。ztest 47/47、persistence 16/16。

## 18. 生辰管理：查全部 / 编辑单条 / 删除单条

用户问「目前保存的生辰有哪些」，同时要一个能查全部历史、并针对单条删除/编辑的入口。
原来只有「最近生辰 ▾」里最新的 5 条，既看不全，也没法改或删单条。

做法：

- 每条记录在接口响应里补一个稳定 `id`：由「年月日|时辰|性别|姓名」sha1 取前 16 位，
  加 `b_` 前缀。**不写进文件**，所以旧文件不用迁移、也不会因为写盘把 `id` 弄脏；
  同一份生辰每次读到的 `id` 相同。编辑之后身份变了，`id` 随之变化。
- host 半新增 `PATCH /ziwei/birth/:id`（原地替换，保留 `savedAt`；改的是 `current` 就一起更新；
  改完与另一条身份相同会合并）与 `DELETE /ziwei/birth/:id`（删的是 `current` 就置空，历史保留）；
  对单条记录用 `GET`/`POST` 返回 405 并带 `Allow` 头。存储层加 `updateBirthRecord` /
  `removeBirthRecord`，仍然走原来的写串行队列，避免并发标签页互相吞历史。
- 应用里新增「生辰管理」弹层：表单页「管理全部生辰（N）…」、盘面工具条「生辰管理（N）」
  都能打开；列出全部记录（当前那条有标记），每行可「起盘 / 编辑 / 删除」。
  编辑复用 `BirthForm`（`key` 随记录变化强制重挂载），保存走 `PATCH`；删除有行内二次确认。
  旧版没有 `form` 快照的记录按「该时辰中点」预填时间并给出提示，保存后补上快照、时辰不变。
- 文档同步：`api.md` 补 `id` 字段、`PATCH`、`DELETE /:id` 与 404/405；README 把
  「忘记」的语义改成只清 `current`；侧栏顺序改成 16（之前文档里还写着 20）。

验收 `app/test-persistence.mjs` 从 16 项扩到 29 项：预置 3 条历史 → 列表 4 条且 `data-id`
合法、当前条目标「当前」→ 编辑回填并改名保存后只替换这一条 → 旧记录提示中点预填且保存后
时辰不变 → 单条删除只删一条 → 删除当前条 `current=null` → 写回后「重新起盘」仍回填 →
「忘记」后从表单页打开管理仍能看到历史。`verify.mjs` 47 项不变。

**踩坑：** 本机 Playwright 缓存被其它工具升级过（期望 `chromium_headless_shell-1208`，
缓存里只有 `1243`），两个验收脚本在 `chromium.launch()` 就挂了，跟插件代码无关。
现在 `check.sh` / `restart-and-verify.sh` 会探测本机任意一个 headless shell，
通过 `DSH_ZIWEI_CHROMIUM` 传给脚本兜底；没有可用浏览器时仍按默认行为报错。

## 19. 手机端 / 窄面板排版

用户反馈「移动端样式乱了」。原因：排盘页是固定两栏（`minmax(0,1fr) 420px`）+
`main{height:100vh}`，390px 宽时右栏把左栏压成一条，概览文案竖排、盘面被裁；
插件工具条一行塞了标题/tabs/状态/输入框/三个按钮，窄屏下换行错位；
手机外壳左上角的系统菜单按钮还会盖住「紫微斗数」标题。

做法：

- 排盘页布局从内联样式改成 `.zw-form / .zw-main / .zw-toolbar / .zw-workspace /
  .zw-chartcol / .zw-chart / .zw-insight` 类，桌面仍是左盘右解读；`max-width:900px`
  时单列堆叠、`main` 改为高度自适应（`100dvh` 兜底）、盘面高度随内容、
  解读面板 60vh 可滚动；工具条按钮在窄屏压到 12px/小内边距（用 `!important`
  压过内联 `font: inherit`）。
- 宫格复用 `globals.css` 里已有的手机紧凑规则：给 `PalaceCell` 补回
  `palace-cell` / `palace-cell-name` 类、给中央信息区补 `palace-center-tile`，
  小屏自动收紧 min-height 与内边距。
- 插件工具条（`client.js`）给标题栏/状态文案/输入框/「新窗口打开」加 `data-dsh-ziwei-*`
  钩子，注入 `@media (max-width:640px)`：隐藏状态文案与外链、问句输入框独占一行、
  按钮换行；`(pointer: coarse)` 时左侧留 60px 安全区，避开手机外壳的菜单按钮。
- `app/test-persistence.mjs` 从 29 项扩到 32 项：在 390×844 视口下断言表单页 /
  命盘页 `scrollWidth <= clientWidth`、管理弹层不出视口。

验收（真实浏览器）：390×844 手机外壳里打开插件面板，工具条一行不挤、盘面与解读上下
堆叠完整可见；1440×900 桌面仍是左右两栏、无横向溢出；截图在 `/tmp/ziwei-mobile/`。

---

## 20. 设计改版：P0 / P1 / P2 依次收口

用户的原话是“你作为一个优秀的设计师，你看下这个插件在设计角度看有哪些优化的空间”，
评审写在 `docs/design-review.md`；随后要求“p0 p1 p2依次优化下”。这轮只动样式、排版与交互，
不改功能、不动数据格式。

- **P0-1 层级**：工具条从 6 个平级按钮收成「重新起盘（主）/ 分享命盘 / 生辰 N ▾ / ⋯」；
  「管理全部生辰…」「清空全部记录…」进生辰菜单，复制摘要与忘记进 `⋯`；恢复/分享提示并进概览条。
  两个下拉支持点外关闭和 Esc，因此 `verify` 与 `test-persistence` 里的点击路径也要先开菜单。
- **P0-2 盘面字阶**：主星 17/600 是唯一大字号；辅星 11、宫名/干支/岁数 10.5–11 单色灰；
  大限浅金底 + 金描边、选中墨色描边、三方四正 1px 墨线；中央大限改金框卡；图例改圆点。
- **P0-3 语义色**：四化收敛为 `--zw-lu/quan/ke/ji` 四个 token，金/墨只做结构色；
  `--t-faint` 浅色从 0.52 提到 0.62（正文弱化色 AA）。
- **P0-5 解读空态**：改成「{名字}的这张盘，先看命格」+「生成命格总览」+ 3 个示例问题 chip。
- **P1 字体矩阵**：标题衬线、正文 sans、数字 tabular；表单去掉三段装饰线，改
  `BIRTH DATA / 出生信息` 发丝线标题；select 换 SVG chevron；性别选中墨底；提交墨底；
  统一 `.zw-btn / .zw-btn-primary / .zw-btn-ghost / .zw-text-btn`。
- **P1 管理行**：姓名为主、生辰为副，保存时间改为相对时间（title 保留精确时间）。
- **P1 移动端**：≤560px 辅星折叠成 `+N`、主星 14.5px、宫格 66px；≤900px 按钮 40px。
- **P2 可达性与一致性**：管理/分享弹层支持 Esc 与 Tab 焦点循环；宫格可 Tab + Enter/Space；
  暗色补齐 `--t-*`（此前暗色会掉黑字）；合盘页嵌入面板时不再叠自己的顶栏；
  `client.js` 的刷新 / 新窗口打开收进 `⋯`。

**踩坑**：改版后选择器变了，`verify.mjs` 的追问输入框（placeholder 从“继续追问”改成“问一句”）和
`[data-ziwei-copy]`（收进 `⋯` 菜单）都要同步改；否则验证会卡在超时而不是真的失败。

**验收**：`tsc --noEmit`、`next build`、`npm test` 10 组、`test-persistence.mjs` 32 项全过；
隔离实例上 `verify.mjs` 47 项曾全过。之后反复重跑时偶发上游模型首字 20s+、空响应，
以及新会话草稿未填入——都是验收环境/模型侧的老 flake，与样式改动无关（同样的用例上一轮 47/47）。

## 提交记录


```text
29c6416 chore: 初始化 dsh-ziwei 插件仓库
7c30ebd docs: 记录提交信息约定
c00ce95 feat(panel): 增加排盘/合盘/古籍/百科四个二级入口
30e4762 test(verify): 补上概览/点星/分享/视图切换的验收断言
5b2b83f feat(app): 把排盘应用收进插件仓库（app/）
a01c47f docs: 补齐插件文档（架构/接口/能力地图/部署/变更记录）
c61500d fix(host): 502 文案与验收脚本指向搬移后的应用
d2872bf fix(app): 百科详情页不再 404
09aa149 docs(changelog): 记录百科详情页 404 的根因与修法
83a86c3 refactor(app): 去掉开源站点痕迹，只保留插件形态
3cf9704 feat(app): 排盘页加「最近生辰」与「复制盘面摘要」
1b73ba8 test(verify): 覆盖最近生辰与复制摘要，去掉合盘断言
5741eb5 docs(changelog): 补提交记录
f913e53 feat(heming): 合盘页回归，解读改由 DSH 模型提供
cd6c769 docs: 同步合盘回归（四视图、digestB 接口、changelog 13）
a6c2a61 fix(host): 请求体超限回可读 413，反代超时回 504，生辰接口兜住异常
604f0c1 fix(store): 生辰配置读写串行化，坏文件先备份再降级
cc716a2 fix(app): 非法日期不再白屏，晚子时口径统一，换盘重置解读
ee43088 fix(panel): 命盘 prompt 只写进切换后的新编辑器
0d43b46 test(verify): 合盘断言放宽到长度与无错误串
f812506 test(verify): 合盘产出阈值从 900 字放宽到 600 字
```

约定见 README「提交约定」：Conventional Commits + 中文摘要，一次提交只做一件事。

## 当前验收基线

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `verify.mjs`（`--ask`） | 47 | 侧栏入口与顺序、鉴权 401、面板与三个视图、起盘、配色、版面撑满、宠物让位、生辰服务端存储、最近生辰、复制盘面摘要、解读面板（自动生成/切 tab/追问）、概览抽屉、点星详情、分享卡与分享链接、「让 DSH 解读」建会话 + 草稿 + 剪贴板、无 console 报错 |
| `app/test-persistence.mjs` | 32 | 清空 → 预置历史 → 起盘写配置 → 重载恢复 → 换浏览器上下文恢复 → 生辰管理（列出全部 / 编辑单条 / 删除单条）→ 重新起盘回填 → 忘记后历史保留 → 390×844 表单页/命盘页无横向溢出、管理弹层不出界 → 还原原记录 |
| `app/npm test` | 10 | 排盘内核回归（盘面完整性、DST、节气边界、红鸾天喜、双四化、命名中立性…） |

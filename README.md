# dsh-ziwei · 紫微斗数（DSH 插件）

把本地跑的 [紫微斗数排盘](https://github.com/)（`/root/workspace/ziwei-doushu`）装进 DSH：
侧栏「插件」组里，**Automation tasks** 下面多一行 **紫微斗数**，点开就是排盘主页面，
不用再走公网域名；盘面可以直接交给 DSH 的 Agent 解读。

- 侧栏顺序：Automation tasks(10) → **紫微斗数(20)** → Skill Center(30)
- 公网入口（`hermes.frankfurtlin.top/ziwei/`）已于 2026-11-03 撤掉，现在只能通过 DSH 登录态访问
- 插件目录：`/root/workspace/plugins/dsh-ziwei`，注册在 `/root/.dsh/profiles/web/package.json`

## 它由哪几块组成

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明 `dsh.bundle.patch`（cordis patch）、`dsh.client.platform=web`、`exports["./client"]` |
| `cordis.patch.yml` | `- insert: [{id: dsh-ziwei, name: dsh-ziwei}]`，id 必须等于包名 |
| `lib/index.js` | host 半：注册 `prefix /ziwei` 反向代理 → `http://127.0.0.1:8815`，先过 DSH 自己的登录闸门；`/ziwei/ai`（模型解读）与 `/ziwei/birth`（生辰配置）走自己的 handler |
| `lib/ai.js` | host 半：解读接口，用 `ctx.llm.stream()` 调宿主模型，SSE 流式回吐 |
| `lib/birth-store.js` | host 半：生辰的服务端存储，读写 `$DSH_HOME/ziwei/birth.json`（0600） |
| `client.js` | client 半：注册侧栏行（panellist 座位）+ 主面板（main 座位，keyed=`ziwei`），内嵌同源 iframe |
| `verify.mjs` | 真实浏览器验收（playwright），默认打测试实例，可指定生产地址 |
| `restart-and-verify.sh` | 生产重启 + 自动验收，脱离当前会话执行（见下） |

### 解读只走 DSH

排盘应用自带的 AI 面板（`InsightPanel` / `ChatPanel` / `app/api/interpret`）已经删除——
既然做成插件，解读就用宿主的能力：盘面摘要通过 `postMessage` 交给插件工具条的
「让 DSH 解读」，由 DSH Agent 出解读并支持继续追问。因此：

- 排盘页只剩「命盘」本体，单栏铺满；
- 应用里只剩排盘所需的纯前端代码，不再需要任何 `AI_*` 环境变量（`.env.local` 里的旧键可以留着不管，删掉也不影响）。

### 生辰记忆（服务端配置文件）

输入过一次生辰后，下次打开排盘页会自动恢复上次的盘，不用重填：

- 存在宿主上的配置文件里：`~/.dsh/ziwei/birth.json`（即 `$DSH_HOME/ziwei/birth.json`，
  可用 `DSH_ZIWEI_BIRTH_FILE` 覆盖），文件权限 `0600`。结构：
  ```json
  { "version": 1,
    "current": { "savedAt": "...", "info": { "year": 1990, "month": 6, "day": 15, "hour": 5, "gender": "male" }, "form": { "...": "表单原始快照" } },
    "history": [ { "savedAt": "...", "info": { }, "form": { } } ] }
  ```
  `current` 用来恢复命盘，`history` 保留最近 20 次不同的人生辰（同一个人重复起盘只留一条）。
- 读写走同源接口 `GET/POST/DELETE /ziwei/birth`，和 `/ziwei/ai` 一样在 DSH 登录闸门后面：
  未登录 401，公网拿不到；数据只写本机文件，不上传、不经过第三方。
- 好处是**换浏览器/换设备/清缓存都能恢复**；代价是这属于本机的敏感数据，
  文件 0600、只有当前用户能读。
- 「忘记这个生辰」（表单页）或盘面页的「忘记」→ `DELETE`，把 `current` 与 `history` 一起清空。
- 早期版本写过浏览器 `localStorage`（键 `ziwei-birth-v1`）；页面加载时会顺手把那条旧记录删掉。
- 恢复盘面时**不会**自动调用模型（省一次调用）：面板显示「已恢复上次生辰的命盘，
  点上面的标签即可解读」；只有手动起盘那一轮才会自动生成「命格总览」。
- 回归测试：`node test-persistence.mjs --url http://127.0.0.1:3099/ziwei/chart --token <token>`
  （清空 → 起盘写配置 → 重载恢复 → 换浏览器上下文仍能恢复 → 重新起盘回填 → 忘记清空；
  会先快照并在结束时还原生产上已有的记录，不会冲掉用户数据）。

### 版面：撑满可用高度

内嵌在 DSH 面板里时，排盘页按 iframe 的高度铺满（`main { height: 100vh }`，
盘面 4×4 网格行高 `1fr` 拉伸），不再在下面留一大片空白：

- 左列命盘吃掉除标题栏外的全部高度；右列「命理解读」也是整列满高。
- 右下角是 dsh-pet 的固定浮层，会盖在 iframe 之上。插件每 2s 量一次宠物在 iframe
  里的遮挡矩形，`postMessage({type:'dsh-ziwei:insets', bottom, right})` 给排盘页，
  输入区据此让开（页面 `<main data-pet-insets="bottom,right">` 便于验收断言），
  否则「追问」按钮的真实点击会被宠物吞掉。

### 解读面板：由 DSH 的模型生成

排盘页右侧的「命理解读」是插件提供的，不用应用自己的 API Key：

- 应用侧 `components/InsightPanel.tsx` 直接 `fetch("/ziwei/ai")`（同源同 basePath），
  六个 tab（命格/感情/事业/财运/健康/性格）+ 底部追问框；盘面摘要由
  `lib/ziwei/digest.ts` 压成文本随请求一起发过去。
- 插件 host 半 `lib/ai.js` 用 `ctx.llm.stream()` 走**宿主当前默认模型**
  （`agentDefaultModel.currentSelection()`，目前 opencode-go / deepseek-v4.1-flash），
  SSE 流式回吐 `{type:'delta'|'reasoning'|'error'|'done'}`，所以解读质量和你在
  DSH 里聊天的模型完全一致，也不需要第二份凭据。
- 请求头 `x-ziwei-thread`（页面会话级 uuid）会作为 `sessionId` 传下去：
  opencode 路由要求 `x-opencode-session`，缺失会 400 `MissingSessionID`。
- `reasoningEffort` 显式压到 `low`，否则 deepseek-v4.1 会先思考很久，
  面板 90 秒内一个字都出不来；思考期间面板显示「模型正在思考这张盘…（已思考 N 字）」。
- 思考也吃输出预算：预算给小了会出现「只想不说」（finish 可能是 `stop` 也可能
  `max-tokens`，正文一个字没有）。所以首轮 2600 tokens，若仍无正文就放大到
  6000 并要求「直接输出正文」重试一次。
- 历史里的 assistant 消息必须带 `source: { kind: 'model', provider, model }`，
  否则 pi-ai 适配器在 `toPiAssistant()` 里读 `message.source.replayState` 直接抛 TypeError。

### 配色：跟随 DSH 外壳

排盘应用本身支持浅/深两套 token（`app/globals.css` 的 `:root` 与 `[data-theme="dark"]`）。
插件做了两件事让两边一致：

- iframe 地址带 `?theme=light|dark`，取自外壳的 `color-scheme`（外壳是白色就是 light）；
- 外壳切主题时（`MutationObserver` 监听 `<html>` 的 style/class）用
  `postMessage({type:'dsh-ziwei:theme', theme})` 推给内嵌页，只换主题、不重载，盘面不丢。

应用侧 `app/layout.tsx` 的首屏脚本优先级：URL `?theme=` → localStorage → **默认 light**。
所以即使没有插件参数，独立打开也是浅色。

### 安全模型

`lib/index.js` 在每个请求上调用宿主注入的 `ctx.connection.requestRejection(req)`：

- 不是受信 Host/Origin → 403
- 没有 DSH 登录态 → 401

所以 `/ziwei` 跟着 DSH 走，公网既没有匿名入口，也不需要额外维护一套鉴权。
`/ziwei/*` 之外的其他路径仍然 404，不会借道转发到别的服务。

### 「让 DSH 解读」怎么工作

1. 内嵌页（Next.js，`basePath=/ziwei`）起盘后把盘面摘要 `postMessage` 给宿主页面
   （`app/chart/page.tsx` + `lib/ziwei/digest.ts` 生成人类可读的十二宫/四化文本）。
2. 点「让 DSH 解读」→ `uiWorkspace.startSession(workspaceId, {prompt})` 新开一个会话，
   然后插件把 prompt 插进宿主的 Lexical 草稿（宿主没暴露写草稿的 API，用
   `document.execCommand('insertText')` 走浏览器原生插入，等价于粘贴、可撤销），
   同时复制一份到剪贴板兜底。
3. 会话里就是完整的命盘 + 你补充的问题，按回车即开始解读。

## 怎么验证

```bash
cd /root/workspace/plugins/dsh-ziwei
npm run check     # node --check lib/index.js && node --check client.js
```

测试实例跑法（端到端，不碰生产）：

```bash
# 1) 起实例（profile 目录 /root/.dsh-ztest 是生产 web profile 的只读链接副本）
DSH_HOME=/root/.dsh-ztest DSH_PASSWORDS_ENV_FILE=/root/.dsh/dsh-passwords/.env \
  setsid nohup /root/.nvm/versions/node/v24.21.0/bin/dsh \
  --profile ztest --no-open --host 127.0.0.1 --port 3099 > /tmp/ztest.log 2>&1 &

# 2) 取带 token 的地址（每次 boot 都变）
grep -o 'http://127.0.0.1:3099/?token=[A-Za-z0-9_-]*' /tmp/ztest.log | head -1

# 3) 跑验收（--ask 会真的点一次「让 DSH 解读」，断言草稿被填入）
node verify.mjs --url "<上面那行地址>" --out /tmp/ziwei-verify --ask
```

生产验收：

```bash
TOKEN=$(journalctl -u deepseek-harness.service | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1)
node verify.mjs --url "$TOKEN" --out /root/workspace/plugins/dsh-ziwei/verification/prod --ask
```

验收覆盖：未登录 401、侧栏入口及其顺序、点击开主面板、iframe 渲染、登录态 200、
iframe 内起盘、盘面桥接生效、点「让 DSH 解读」开新会话、草稿被填入、剪贴板兜底、
无控制台报错。

## 改完代码怎么生效

`client.js` 由宿主按请求从磁盘拼进 `/plugins/??…` 束（`link:` 本地插件，
实测改完只要**刷新页面**就生效，不需要重启 DSH；早前"必须重启"的判断是浏览器缓存导致的误判）。
`lib/index.js`（host 半）改完才需要重启 DSH——那会杀掉当前会话这一轮，用脱离会话的方式：

```bash
# 用法：restart-and-verify.sh [延迟秒数]
sudo systemd-run --on-active=10s --unit=dsh-ziwei-verify \
  /root/workspace/plugins/dsh-ziwei/restart-and-verify.sh
```

脚本会：等一会儿 → `systemctl restart deepseek-harness` → 等 3080 起来 →
从 journal 取 token → 跑 `verify.mjs --ask` → 报告写到 `verification/prod/`。

## 主题验收

`verify.mjs` 里有一条「内嵌页配色跟随 DSH 外壳」：读外壳的 `color-scheme`，再读 iframe 里的
`<html data-theme>`，两者必须一致。最近的图标见 `verification/light/`。

## 验收项（20）

侧栏入口与顺序、面板打开、iframe 渲染、配色跟随外壳、登录/未登录鉴权、起盘、
**解读面板存在（由 DSH 模型生成）**、**应用旧 `/api/interpret` 已 404**、
**自动生成命格解读**、**切 tab 重新解读**、**追问按钮不被宠物浮层遮挡**、
**追问带上下文继续解读**、**起盘后生辰写入 localStorage**、盘面桥接、新会话、
草稿预填、剪贴板兜底、无控制台报错。
截图在 `verification/`（`03-chart-bridged.png`、`05-panel-reading.png`）。

## 依赖

- 排盘应用本身：`/root/workspace/ziwei-doushu`，`ziwei-doushu.service`，监听 `127.0.0.1:8815`，
  `NEXT_PUBLIC_BASE_PATH=/ziwei`、`next.config.js` 里 `basePath: '/ziwei'`。
- playwright（只验收用）：复用 `/root/workspace/hermes-site/tools/node_modules`，
  浏览器在 `/root/.cache/ms-playwright`。

## 已知限制

- 排盘应用自带的「命理解读」（`/api/interpret`）走它自己的模型配置，跟插件无关；
  插件路径是 DSH 的 Agent，用你自己的模型和额度。
- 「让 DSH 解读」要求至少有一个 Workspace；全新 DSH_HOME 会先由
  `workspaces.initializeDefault()` 建默认工作区再开会话。
- 草稿插入依赖浏览器 `execCommand`，失败时退化为「剪贴板 + 用户手动粘贴」。

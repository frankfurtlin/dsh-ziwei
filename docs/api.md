# 接口（host 半）

三个入口都挂在 `/ziwei` 前缀下，**都先过 DSH 的登录闸门**（`ctx.connection.requestRejection`）：
未登录 401，Host/Origin 不可信 403，公网没有第二条路能进来。

| 方法 | 路径 | 处理者 | 作用 |
| --- | --- | --- | --- |
| `*` | `/ziwei/ai` | `lib/ai.js` | 用宿主模型流式生成解读（SSE） |
| `GET/POST/DELETE` | `/ziwei/birth` | `lib/birth-store.js` | 生辰配置的读写 |
| `*` | 其它 `/ziwei/*` | 反代 | 转给 `127.0.0.1:8815` 的 Next.js 应用 |

调用方（内嵌页）用的是相对路径，所以 cookie 自动带上，不需要额外 token。
调试时手工调用要带登录 cookie：先 `curl -c /tmp/jar "<dsh地址>/?token=…"`。
测试实例上的 token 每次启动都变，取法见 [deploy.md](./deploy.md#取-token)。

---

## 1. `POST /ziwei/ai` — 模型解读（SSE）

### 请求

```http
POST /ziwei/ai HTTP/1.1
Content-Type: application/json
x-ziwei-thread: 6f1c2b0e-3a44-4f0b-9c1d-2f4a5c6d7e8f
```

```json
{
  "topic": "overview",
  "digest": "【基本信息】公历：1990年6月15日 午时（男）…【十二宫】…",
  "question": "今年换工作怎么样？",
  "history": [
    { "role": "user", "content": "帮我看看感情" },
    { "role": "assistant", "content": "……" }
  ]
}
```

| 字段 | 必填 | 限制 | 说明 |
| --- | --- | --- | --- |
| `digest` | ✅ | ≤ 16000 字符 | 盘面摘要，由应用 `lib/ziwei/digest.ts` 的 `digestChart()` 生成（纯文本，星/宫/四化结构化列出） |
| `topic` | | — | `overview` / `love` / `career` / `wealth` / `health` / `personality` / `heming`，决定提示词模板；缺省 `overview` |
| `digestB` | | ≤ 16000 字符 | 第二张盘（乙方）的摘要，仅 `topic: "heming"` 时使用；两段会分别标成【甲方命盘】【乙方命盘】 |
| `question` | | ≤ 2000 字符 | 追问内容，空则是「按主题自动解读」 |
| `history` | | 只取最后 8 轮 | 追问时带上上下文，`role` 为 `user` / `assistant` |

请求头 `x-ziwei-thread`：8–128 位 `[\w.:-]`。它会作为 `sessionId` 传给模型适配器
（opencode 这类路由要求 `x-opencode-session`，没有就 400 `MissingSessionID`）。
内嵌页按页面生成一个 UUID，同一页面里的追问复用同一个值。

### 响应（`text/event-stream`）

```text
data: {"type":"reasoning","chars":37}

data: {"type":"delta","text":"先说结论："}

data: {"type":"delta","text":"你这张盘在感情上…"}

data: {"type":"done"}
```

| 事件 | 字段 | 前端怎么用 |
| --- | --- | --- |
| `reasoning` | `chars` | 只报「思考了多少字」，面板显示「模型正在思考这张盘…（已思考 N 字）」 |
| `delta` | `text` | 正文增量，直接追加渲染 |
| `error` | `message` | 红字提示；`done` 仍会跟着发一条 |
| `done` | 无字段 | 收尾，stop loading；不再回报 provider/model（界面用不到，少一处指纹） |

设计要点（都是踩过坑才加上的）：

- **显式压低思考强度**：`reasoningEffort: 'low'`（可用环境变量
  `DSH_ZIWEI_AI_REASONING` 覆盖，仅用于调参；`off`/`minimal` 这个模型不支持，会报
  `does not support reasoning effort "off"`）。默认 `high` 时 90 秒都只在
  `reasoning-delta` 里打转，用户看到的是长时间空白。
- **提示词里限制内部推演**：系统提示末尾专门写了「动手前只想两件事，想完立刻写正文，
  不要逐宫罗列推演」。这一条把首字延迟从 **27.5s 压到 6.6s**（同一张盘、同一模型实测），
  整段产出从 33s 压到 12s。思考本身依然存在（`reasoning` 事件报字数），但不再漫无边际。
- **前端平滑吐词**：SSE 增量实测 1–24 字混杂、偶尔卡 0.4s。内嵌页不直接把 delta 塞进
  React，而是先进缓冲、再用 30fps 定时器匀速放出（积压多时单帧多放几个字），
  验收采样最长停顿从 1190ms 降到 **170ms**。
- **输出预算会思考吃光**：`maxTokens` 首轮 2600；如果这一轮一个字正文都没吐
  （`finish=max-tokens` 或 `stop` 但空），自动放大到 6000 并追加一句
  「请直接输出正文，不要反复推演」重试一次；仍无正文才报错。
- **超时与取消**：整体 180 秒；`res.on('close')` 触发 `AbortController`，
  用户关面板/切视图就停掉上游调用，不浪费额度。
- **assistant 历史必须带 `source`**：pi-ai 适配器会读 `message.source.replayState`，
  历史里缺 `source` 会抛 `Cannot read properties of undefined (reading 'replayState')`。
  `buildMessages()` 已补 `source: { kind: 'model', provider, model }`。
- **调试开关**：`DSH_ZIWEI_AI_DEBUG=1` 会把每个 chunk 打到宿主日志（默认关）。

### 错误码

| 状态 | 场景 | 体 |
| --- | --- | --- |
| 405 | 不是 POST | `{"error":"只接受 POST"}` |
| 503 | `ctx.llm` 不可用 | `{"error":"DSH 的模型服务没有就绪（ctx.llm 不可用）。"}` |
| 503 | 没有默认模型 | `{"error":"还没有选中模型：请在 DSH 的「设置 → 模型」里选一个默认模型，再回来解读。"}` |
| 400 | 请求体不是 JSON / 缺 digest | `{"error":"…"}` |

### 手工验证

```bash
curl -N -b /tmp/jar -X POST http://127.0.0.1:3080/ziwei/ai \
  -H 'content-type: application/json' \
  -H "x-ziwei-thread: debug-thread-0001" \
  -d '{"topic":"overview","digest":"【基本信息】公历：1990年6月15日 午时（男）\n【十二宫】命宫（丑）：紫微、天相"}'

# 合盘：两张盘一起发
curl -X POST http://127.0.0.1:3080/ziwei/ai -H 'content-type: application/json' \
  -H 'x-ziwei-thread: heming-demo-0001' \
  -d '{"topic":"heming","digest":"【甲方命盘】…","digestB":"【乙方命盘】…","question":"适合合伙创业吗？"}'
```

---

## 2. `GET|POST|DELETE /ziwei/birth` — 生辰配置

存储文件：`$DSH_HOME/ziwei/birth.json`（默认 `~/.dsh/ziwei/birth.json`，
可用 `DSH_ZIWEI_BIRTH_FILE` 覆盖），权限 `0600`，写盘走「临时文件 + rename」。

```json
{
  "version": 1,
  "current": {
    "savedAt": "2026-11-03T07:20:11.412Z",
    "info": { "year": 1990, "month": 6, "day": 15, "hour": 5, "gender": "male" },
    "form": { "year": "1990", "month": "6", "day": "15", "hour": "5", "minute": "30", "gender": "male", "name": "…", "province": "…", "city": "…" }
  },
  "history": [ { "savedAt": "…", "info": {}, "form": {} } ]
}
```

- `current` 用来「下次打开自动恢复命盘」；`history` 保留最近 **20** 条不同生辰
  （同一个人重复起盘只更新 `current`，不新增）。
- `hour` 是**时辰序号 0–11**（0=子时 … 11=亥时），不是小时；`form` 是表单原始快照，
  用于「重新起盘」时回填。

### `GET`

```json
{ "ok": true, "current": { … } | null, "history": [ … ], "file": "ziwei/birth.json" }
```

### `POST`

```json
{ "info": { "year": 1990, "month": 6, "day": 15, "hour": 5, "gender": "male" },
  "form": { "year": "1990", "month": "6", "day": "15", "hour": "5", "minute": "30", "gender": "male" } }
```

返回 `{ ok: true, current: {…}, file: "ziwei/birth.json" }`。`info` 非法（年月日/时辰越界、
gender 不是 `male|female`）→ 400。

> `file` 只回相对 `$DSH_HOME` 的位置。真实路径（`/root/.dsh/ziwei/birth.json`）不会出现在
> 任何响应里：绝对路径会漏出用户名与本机目录结构。

### `DELETE`

两种作用范围，靠查询参数区分：

| 请求 | 作用 | 响应 |
| --- | --- | --- |
| `DELETE /ziwei/birth` | 只清 `current`（下次打开不再自动恢复），**`history` 保留** | `{ ok: true, scope: "current", current: null, history: [...] }` |
| `DELETE /ziwei/birth?scope=all` | `current` 与 `history` 一起清空 | `{ ok: true, scope: "all", current: null, history: [] }` |

界面对应：「忘记这个生辰」/「忘记」= 默认那一种（保留最近列表），「清空全部记录…」=
`scope=all`（清空前会二次确认）。

> 早期版本默认就把 `history` 一起删了，用户点一次「忘记」等于抹掉全部记录，
> 验收脚本回写时也只用 `current`，把「最近生辰」的历史冲掉过。默认值改保守了以后，
> 删除全部必须显式写 `?scope=all`。

| 状态 | 场景 |
| --- | --- |
| 400 | JSON 解析失败、缺请求体、`info` 非法 |
| 405 | 用了 GET/POST/DELETE 以外的方法（带 `Allow` 头） |
| 413 | 请求体超过 256 KiB |

---

## 3. 其它 `/ziwei/*` — 反代

把请求原样转给 `127.0.0.1:8815`（端口可用 `DSH_ZIWEI_UPSTREAM_PORT` 覆盖）：

- 剥掉 hop-by-hop 头（`connection`、`keep-alive`、`proxy-*`、`te`、`trailer`、
  `transfer-encoding`、`upgrade`），补 `x-forwarded-host/proto/for`；
- 响应体直接 pipe 回浏览器，静态资源、SSE、Range 都照常；
- 上游连不上 → **502**，正文只提示「紫微斗数应用暂时不可用，请稍后重试。」；错误码与
  单元名只写宿主日志（`console.warn('[dsh-ziwei] 反代失败（ECONNREFUSED）…')`）；
- 上游 10 秒不响应 → **504**「紫微斗数应用响应超时，请稍后重试。」；
- 客户端断开 → 立刻销毁上游请求，不留悬挂连接。

面板里看到「应用暂时不可用」，基本都是 `dsh-ziwei-app.service` 没起来
（或 8815 被别的东西占了），排查见 [deploy.md](./deploy.md#故障排查)。

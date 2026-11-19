# 自检与验收

这个插件的验收不只是「代码能跑」：它由两半组成（`lib/` 宿主半 + `app/` 内嵌应用），
真正的行为只有在 DSH 里打开面板、点按钮、看模型吐字才算数。所以验收全部是
**真实浏览器 + 真实宿主进程**，不是 mock。

**规矩：改完代码跑 `scripts/check.sh`，全绿再提交。**

```bash
scripts/check.sh            # 全套（静态 → 构建 → 隔离实例端到端），约 2–3 分钟
scripts/check.sh --static   # 只跑静态检查，约 40 秒（pre-commit 钩子跑的就是这个）
scripts/check.sh --no-build # 只改了插件代码、没动 app/ 时用，跳过 next build
scripts/install-hooks.sh    # 装 pre-commit：静态检查不过就提交不了（--no-verify 可跳过）
```

产物落在 `verification/check/`（已被 `.gitignore` 忽略）：

| 文件 | 内容 |
| --- | --- |
| `report.json` | verify 的 47 项结构化结果（每项 name/ok/detail） |
| `logs/verify.log`、`logs/persistence.log` | 两个验收脚本的完整输出 |
| `logs/*.log` | 静态检查与构建的日志 |
| `persistence/` | 生辰存储验收的截图 |
| `01-sidebar.png` … `09-panel-knowledge.png` | 面板与各视图截图（`--ask` 才有会话那两张） |

---

## 一、`scripts/check.sh` 干了什么

### 第 1 步：静态检查

| 检查 | 说明 |
| --- | --- |
| `node --check` × 6 | `lib/index.js`、`lib/ai.js`、`lib/birth-store.js`、`client.js`、`verify.mjs`、`app/test-persistence.mjs` |
| `tsc --noEmit` | 内嵌应用全量类型检查（`app/` 是 Next.js + TS） |
| `npm test`（10 组） | 排盘内核回归：盘面完整性、DST、真太阳时校正、立春边界、红鸾天喜、名人时辰、iztro 时辰索引、不存在的公历日期、双四化同宫、中性命名 |

### 第 2 步：构建 + 重启内嵌应用

`app/npm run build` → `systemctl restart dsh-ziwei-app.service` → 等 `127.0.0.1:8815/ziwei/chart` 回 200。
插件反代的就是这个服务，所以它必须是新的。

> 改 `app/` 后忘 build 是踩过的坑：产物是旧的，DOM 里查不到新加的 `data-*` 锚点，
> 表现为「代码明明改了却没生效」。排查办法：
> `curl -s http://127.0.0.1:8815/ziwei/chart | grep -o '/_next/static/chunks/[^"]*'` 拿 chunk 再 grep 锚点。

### 第 3 步：隔离实例上的端到端验收

在 `/tmp/dsh-ziwei-check` 起一个**完全隔离**的 DSH 实例：

- 独立 `DSH_HOME`、独立端口（默认 `3099`，被别的实例占用时自动顺延到 3100–3103）、独立会话/cookie/生辰配置；
- `profiles/check` 用符号链接复用生产 profile 的 `node_modules` 与 `cordis.patch.yml`（不复制 2G 依赖）；
- 复制生产 `.credentials.yaml`（否则 `/ziwei/ai` 报 `no credential`）；
- 复制生产 `storages/workspace.json`（全新 home 没有工作区时，「让 DSH 解读」会卡在「Choose a workspace first」）；
- `DSH_ZIWEI_BIRTH_FILE` 指到实例自己的 `ziwei/birth.json`，**不碰生产那份真实生辰**；
- 跑完自动 kill（`trap` 兜底，脚本中途失败也不留进程）。

跑的两个脚本：

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `verify.mjs --ask` | 47 | 见下方清单 |
| `app/test-persistence.mjs` | 32 | 生辰写进服务端配置 → 重载恢复 → 换浏览器上下文仍能恢复 → 生辰管理（列出全部 / 编辑单条 / 删除单条）→ 重新起盘回填 → 「忘记」只清当前、历史保留 → 手机端 390×844 表单页/命盘页无横向溢出、管理弹层不出界 → 完整还原 |

---

## 二、verify.mjs 的 47 项都验什么

### 鉴权与入口（1、4–10）

- 未登录 `GET /ziwei/` 必须 401（插件 host 半用 `ctx.connection.requestRejection` 挡，不靠应用自己）；
- 侧栏出现「紫微斗数」按钮，且顺序落在 Automation tasks（order 10）与 Skill Center（order 30）之间；
- 点击打开主面板，主面板里的 iframe 能渲染排盘页；
- 登录态 `/ziwei/` 返回 200；
- iframe 内能起盘（选 1990-6-15 → 点提交 → 出现「← 重新起盘」）。

### 版面与主题（8、11、12）

- 内嵌页 `<html data-theme>` 跟随宿主 `colorScheme`（浅色主题 + 跟随外壳）；
- 排盘页纵向撑满：iframe 高 852 时 `main` ≥ 848、`board` ≥ 520、`aside` ≥ iframe-120；
- 插件把 dsh-pet 的遮挡区域算出 `data-pet-insets` 发给内嵌页（宠物是固定悬浮层，
  不动态让位会盖住「追问」按钮，Playwright 的 `force:true` 会掩盖这个问题，所以断言用真实点击 + 求交）。

### 生辰与「最近生辰」（2、3、13–16、32–35、46）

- 起盘后生辰写进服务端配置文件（不是 localStorage），且带表单快照（重新起盘能回填）；
- `GET /ziwei/birth` 只回 `file: "ziwei/birth.json"` 相对路径，不泄漏 `/root/...` 绝对路径；
- `DELETE` 默认只清 `current`、保留 `history`（`current=null history=N`），清空全部要 `?scope=all`；
- 验收结束必须完整还原用户数据（清空 → 按旧→新回放 history → 写回 current），
  并断言恢复条数 ≥ 快照条数（否则说明脚本又把历史冲了）；
- 「最近生辰」列表能列出、点一条能换盘；「复制盘面摘要」写进剪贴板且含【基本信息】与十二宫。

### 解读面板（17–25）

- 面板是插件的（「由 DSH 模型生成」），应用里旧的 `/ziwei/api/interpret` 必须 404；
- 首字延迟 < 20s、最长停顿 < 1.2s（流式节奏回归，防「糊一段卡一下」）；
- 自动生成命格解读、切 tab 重新生成、无回退错误串；
- 「追问」按钮没被宠物盖住，真实点击后带盘面继续解读。

### 命盘页零件（26–31、36）

- 概览抽屉展开含命格总览 / 格局识别 / 本命四化，再点能收起；
- 点星曜弹出详情（含古籍与倪师解读）；
- 分享弹层打开、分享链接带生辰参数、能真实下载 PNG；
- 分享链接打开后能还原同一张盘。

### 多视图（37–42）

面板能在 排盘 / 合盘 / 古籍 / 百科 之间切，iframe URL 随之变化；合盘能出解读；百科页有内容。

### 插件与宿主联动（43–45、47）

- 「让 DSH 解读」能开新会话、命盘 prompt 写进新会话的 Lexical 草稿、同时写进剪贴板兜底；
- 全程没有 console 报错 / pageerror。

---

## 三、`app/test-persistence.mjs` 的 32 项

清空 → 用接口预置 3 条历史（带表单快照的 A、旧版没有快照的 C、用来测删除的 B）→
起盘 1990 → 读出服务端记录（带 `id` 与 `form`）→ reload 自动恢复（不再显示表单）→
**换一个全新 browserContext 仍能恢复**（证明与浏览器存储无关）→

生辰管理：

- 打开「生辰管理」列出全部 4 条，每行带合法 `id`，当前命盘那条标「当前」；
- 编辑 A：表单回填年份与姓名 → 改名保存 → 服务端只替换这一条（不是新增、不残留旧记录）；
- 编辑 C：出现「时间按该时辰中点预填」提示 → 直接保存 → 时辰不变且补上表单快照；
- 删除 B：只少这一条，当前命盘与其它历史保留；
- 删除当前那条：`current=null`，其它历史保留；
- 写回 1990 后重新起盘，表单仍能回填；

「忘记这个生辰」后 `current=null` 但 `history` 还在，且从表单页打开「生辰管理」
仍能看到历史 →

手机端（视口 390×844）：

- 生辰表单页 `scrollWidth <= clientWidth`，不横向溢出；
- 从「最近用过」起盘后，命盘页同样不横向溢出（工具条换行、盘面与解读面板上下堆叠）；
- 「生辰管理」弹层落在视口内（不超出左右边界、顶部不出屏）；

结束时完整还原快照。

---

## 四、生产上线验收

自检通过后，上线要重启 `deepseek-harness`（host 半改动才生效），而重启会杀掉当前会话轮次，
所以用 `systemd-run` 脱离会话执行：

```bash
systemd-run --on-active=120s --unit=dsh-ziwei-deploy \
  /root/workspace/plugins/dsh-ziwei/restart-and-verify.sh
```

`restart-and-verify.sh` = `export HOME=/root`（否则 systemd 单元里 fontconfig 找不到
`/root/.fonts`，截图中文变豆腐块）→ 重启 harness → 等 3080 → 从 journal 取最新 token →
查公网 `https://dsh.frankfurtlin.top/ziwei/` 未登录状态码（302/401 正常，404 说明没接通）→
跑 verify + persistence，结果写 `verification/prod/`。

> 生产验收**不允许**破坏用户数据：两个脚本都会快照 → 断言 → 完整回放还原。
> 这条曾经违反过一次（只回写 `current`，把「最近生辰」历史冲掉了），现在有断言兜着。

---

## 五、常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| 隔离实例起不来、`EADDRINUSE` | 上一次的实例没杀干净，或别的 agent 占了 3099。`pgrep -af '[n]ode .*--profile check'` 找真 node 进程再 kill；脚本本身会自动顺延端口 |
| 日志里没有 token | dsh 只在启动早期打印一次 `?token=`。取 `grep -o '...token=[A-Za-z0-9_-]*' log \| head -1`（`tail -1` 常取空） |
| 「让 DSH 解读」卡在 Choose a workspace | 隔离 home 没有工作区，检查有没有复制 `storages/workspace.json` |
| 解读断言全挂、日志有 `no credential` | 没复制 `.credentials.yaml` |
| 截图里中文是豆腐块 | 缺 `/root/.fonts` 下的 Noto Sans SC，或没 `export HOME=/root` |
| `page.goto` 30s 超时 | dsh web 永远不会 networkidle，必须 `domcontentloaded` + `waitForSelector` |
| 验收把「最近生辰」清空了 | 检查脚本是否用 `?scope=all` 起跑并完整回放 history；`report.json` 里「完整恢复了原有的生辰记录」必须是 PASS |
| `force: true` 掩盖点击失效 | 宠物浮层会拦截真实点击，能用真实点击就别 force |

---

## 六、改完什么要重启什么

| 改动 | 生效方式 |
| --- | --- |
| `client.js`（浏览器半） | 刷新页面即可（每次请求从磁盘拼进 `/plugins/??` 束），不用重启 |
| `lib/*.js`（宿主半） | 必须重启 `deepseek-harness`，**会杀掉当前会话轮次** |
| `app/**` | `npm run build` + 重启 `dsh-ziwei-app.service` |
| 注册信息（`package.json` / `cordis.patch.yml` / profile） | 重启 `deepseek-harness` |

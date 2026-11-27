# 部署与运维

## 组成与端口

| 东西 | 位置 | 端口 | 服务 |
| --- | --- | --- | --- |
| DSH 宿主 | `~/.nvm/.../bin/dsh --profile web` | `127.0.0.1:3080` | `deepseek-harness.service` |
| 插件 | `/opt/dsh/dsh-ziwei`（本仓库） | 借 3080 | 跟着宿主 |
| 排盘应用 | 本仓库 `app/` | `127.0.0.1:8815` | `dsh-ziwei-app.service` |
| 登录网关 | dsh-passwords | `3081` | 转给 3080 |
| Caddy | `/etc/caddy/Caddyfile` | `*:80/*:443` | `caddy.service` |

只在 `127.0.0.1` 上监听，公网只能经 Caddy + 登录网关进来。

## 服务单元（`dsh-ziwei-app.service`）

```ini
[Service]
User=root
WorkingDirectory=/opt/dsh/dsh-ziwei/app
EnvironmentFile=/opt/dsh/dsh-ziwei/app/.env.local
Environment=PATH=~/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=NEXT_PUBLIC_SITE_URL=https://dsh.frankfurtlin.top/ziwei
Environment=NEXT_PUBLIC_BASE_PATH=/ziwei
ExecStart=~/.nvm/versions/node/v24.21.0/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 8815
Restart=on-failure
RestartSec=4
```

> 单元里的 `~` 只是「运行用户的家目录」简写（systemd 不展开 `~`）：真机上先
> `echo $HOME` 展开成绝对路径，再写进单元。
> 应用从 `workspace/ziwei-doushu` 搬到 `plugins/dsh-ziwei/app` 后，老单元
> `ziwei-doushu.service` 已经 disable + 删除，只有这一个单元。

常用：

```bash
systemctl status dsh-ziwei-app.service
systemctl restart dsh-ziwei-app.service
journalctl -u dsh-ziwei-app.service -n 50 --no-pager
```

## 插件怎么注册进 DSH

`~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": { "dsh-ziwei": "link:/opt/dsh/dsh-ziwei" },
  "dsh": { "profile": { "bundles": ["…", "dsh-skin", "dsh-pet", "dsh-ziwei"] } }
}
```

并建符号链接 `~/.dsh/profiles/web/node_modules/dsh-ziwei -> ../../../../workspace/plugins/dsh-ziwei`
（与 `dsh-pet`、`dsh-skin` 同形态）。`cordis.patch.yml` 里 `- insert: [{id: dsh-ziwei, name: dsh-ziwei}]`，
**id 必须等于包名**。

## 改什么、要重启什么（最容易踩的坑）

| 改动 | 生效方式 | 说明 |
| --- | --- | --- |
| `client.js`（client 半） | **刷新页面** | 宿主每次请求从磁盘重新拼 `/plugins/??…` 束，不用重启 DSH |
| `lib/*.js`（host 半） | **重启 `deepseek-harness.service`** | 重启会杀掉当前对话轮次 |
| `app/**` 源码 | `npm run build` + `systemctl restart dsh-ziwei-app.service` | 只改源码不重启，iframe 里还是旧构建 |
| `app/globals.css` / 组件样式 | 同上（`npm run build`） | 走 Next 构建 |
| `~/.dsh/profiles/web/package.json` | 重启 DSH | profile 只在启动时读 |

重启 DSH 会杀死当前会话轮次，所以在会话里要脱离执行：

```bash
systemd-run --on-active=120s --unit=dsh-ziwei-deploy \
  /opt/dsh/dsh-ziwei/restart-and-verify.sh
```

然后用 `schedule_create` 或等它自己把报告写进 `verification/prod/`。

## 构建

```bash
cd /opt/dsh/dsh-ziwei/app
npx tsc --noEmit          # 类型闸门
npm test                  # 10 个排盘回归脚本
npm run build             # 生成 .next
systemctl restart dsh-ziwei-app.service
```

> **坑**：`npm run build` 和编辑器里的文件改动撞车时，会把旧代码打进产物
> （症状：新加的 `data-*` 锚点在 DOM 里查不到、页面行为没变）。
> 诊断：`curl -s http://127.0.0.1:8815/ziwei/chart | grep -o '/ziwei/_next/static/chunks/[^"]*\.js'`
> 逐个 grep 你的锚点，确认没打进去就重跑 build。

## 插件静态检查

```bash
cd /opt/dsh/dsh-ziwei
node --check client.js
node --check lib/index.js && node --check lib/ai.js && node --check lib/birth-store.js
node --check verify.mjs
```

## 验收

### 1) 插件端到端（38 项）

```bash
cd /opt/dsh/dsh-ziwei
node verify.mjs --url "http://127.0.0.1:3080/?token=<token>" --out verification/prod --ask
```

- `--ask` 会真的点一次「让 DSH 解读」，断言新会话打开、草稿被填入、剪贴板兜底生效；
- 不带 `--ask` 就跳过这一步（更快，适合只改样式时）；
- 会先**快照**用户已有的生辰记录，验收结束**写回**，不会冲掉真实数据；
- 截图与 `report.json` 落在 `--out` 目录（`verification/` 已 gitignore，日志里含 token，别提交）。

### 2) 生辰持久化（16 项）

```bash
cd /opt/dsh/dsh-ziwei/app
node test-persistence.mjs --url http://127.0.0.1:8815/ziwei/chart --shots /tmp/birth
```

直连 8815，不需要 DSH token（应用本身不做鉴权，鉴权在插件那一层）。
覆盖：清空 → 起盘写配置 → 重载恢复 → 换浏览器上下文恢复 → 重新起盘回填 → 忘记清空 → 还原原记录。

### 3) 一条命令跑完（重启 + 两项验收）

```bash
/opt/dsh/dsh-ziwei/restart-and-verify.sh
```

脚本内部：从 passwd 取家目录补 `HOME`（否则 systemd 单元里 fontconfig 跳过 `~/.fonts`，
截图中文变豆腐块）→ 重启 DSH → 等 3080 → 从 journal 取 token → 检查公网
`dsh.frankfurtlin.top/ziwei/` 未登录状态码（期望 302/401，404 = 未接通）→
跑 `verify.mjs`（38 项）→ 跑 `app/test-persistence.mjs`（16 项）。

## 取 token

```bash
# 生产
journalctl -u deepseek-harness.service | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1
# 测试实例（每次 boot 都变，注意用 head -1，tail 常取到空）
grep -o 'http://127.0.0.1:3099/?token=[A-Za-z0-9_-]*' /tmp/ztest.log | head -1
```

## 起一个测试实例（不动生产）

```bash
# 一次性准备（复用生产的 node_modules 与凭据，sessions 独立）
mkdir -p ~/.dsh-ztest/profiles/ztest
ln -sf ~/.dsh/profiles/web/package.json      ~/.dsh-ztest/profiles/ztest/package.json
ln -sf ~/.dsh/profiles/web/node_modules      ~/.dsh-ztest/profiles/ztest/node_modules
ln -sf ~/.dsh/profiles/web/cordis.yml        ~/.dsh-ztest/profiles/ztest/cordis.yml
ln -sf ~/.dsh/profiles/web/cordis.patch.yml  ~/.dsh-ztest/profiles/ztest/cordis.patch.yml
cp ~/.dsh/.credentials.yaml ~/.dsh-ztest/.credentials.yaml   # 否则模型报 no credential
cp ~/.dsh/storages/workspace.json ~/.dsh-ztest/storages/workspace.json  # 否则没 Workspace

cd ~/.dsh-ztest && DSH_HOME=~/.dsh-ztest \
  DSH_PASSWORDS_ENV_FILE=~/.dsh/dsh-passwords/.env \
  setsid nohup ~/.nvm/versions/node/v24.21.0/bin/dsh \
  --profile ztest --no-open --host 127.0.0.1 --port 3099 > /tmp/ztest.log 2>&1 &

# 停：只杀真正的 node 进程，别用 pkill -f "profile ztest"（会把自己的 shell 也 SIGTERM）
pkill -f '[n]ode .*dsh --profile ztest'
```

测试实例会打两条无害告警：`dsh-passwords` 抢 3081（「等待其释放后接管」）、
`better-sidebar` 找不到 `@deepseek-ai/dsh-settings`（仅该实例）。

## 回滚

| 场景 | 做法 |
| --- | --- |
| 插件代码改坏 | `cd plugins/dsh-ziwei && git log/l git checkout <commit> -- .`，客户端半刷新、宿主半重启 |
| 应用改坏 | `git checkout <commit> -- app/` 后重新 `npm run build` + 重启 `dsh-ziwei-app` |
| 单元切回旧路径（万一） | `git revert` 对应提交，按上面单元内容改 `WorkingDirectory` 与 `EnvironmentFile` |
| Caddy 公网 `/ziwei` 需要恢复 | `/etc/caddy/Caddyfile.bak-before-rm-ziwei-20261103-120647` 里那段 `handle /ziwei*` 加回去，`caddy validate` 后 `systemctl restart caddy`（admin off，reload 必失败） |

## 故障排查

| 现象 | 先查什么 |
| --- | --- |
| 面板里「应用暂时不可用（ECONNREFUSED）」 | `systemctl status dsh-ziwei-app`；`ss -ltnp \| grep 8815` |
| 面板空白 / 一直转圈 | 浏览器控制台；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8815/ziwei/chart` |
| 侧栏没有「紫微斗数」 | profile 的 `dependencies` + `bundles`；`journalctl -u deepseek-harness \| grep -i ziwei` |
| `/ziwei/` 返回 401 | 正常（未登录）；用带 token 的地址打开 |
| 公网 `/ziwei/` 404 | 正常（已摘除公网路由）；只能在 DSH 登录后访问 |
| 解读一直空 / 「模型没有返回内容」 | 是否选了默认模型（设置 → 模型）；`DSH_ZIWEI_AI_DEBUG=1` 重启宿主看 chunk 日志 |
| 截图中文是豆腐块 | 脚本里 `HOME` 为空；`fc-list \| grep -i "Noto Sans SC"`（字体在 `~/.fonts`） |
| 点「追问」没反应 | 是否被 dsh-pet 浮层挡住：`data-pet-insets` 是否是 `0,0`（宿主没推过来） |

## 与 Caddy 的关系

公网域名铁律：`dsh.frankfurtlin.top` 只承载 DSH（含本插件），
`hermes.frankfurtlin.top` 承载 `/mine /threeui /terraria /earth /starmap /pixel /floorplan /story`。
`/ziwei` 已从 Caddy **摘除**（不公网暴露），所以应用只能从 DSH 里进。

# 排盘应用能力地图（app/）

本仓库的 `app/` 就是原来的独立站点 `workspace/ziwei-doushu`（Next.js 16 + React 19），
已经整体搬进来。**排盘内核 `lib/ziwei/*` 一行没改**，我们动的是外壳、解读、存储和导航。

- 服务：`dsh-ziwei-app.service`，`node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 8815`
- `basePath = /ziwei`（`next.config.js` 与 `NEXT_PUBLIC_BASE_PATH` 一致），所以所有路由都是 `/ziwei/...`
- 环境：`NODE_ENV=production`，`EnvironmentFile=app/.env.local`；应用不需要任何密钥（解读走宿主的 `/ziwei/ai`）
- 已删除的页面：`/heming`（合盘，依赖应用内 AI）、`/preview`（开场动画）、`/privacy`、`/terms`、
  `robots.txt`、`sitemap.xml` —— 它们是原开源站点的落地页/合规页，插件内既无入口也无意义

## 路由表

| 路由 | 文件 | 在插件里怎么进 |
| --- | --- | --- |
| `/ziwei/chart` | `app/chart/page.tsx` | 面板「排盘」（默认视图） |
| `/ziwei/library`、`/ziwei/library/[book]`、`/ziwei/library/[book]/[chapter]`、`/ziwei/library/search` | `app/library/**` | 面板「古籍」 |
| `/ziwei/knowledge`、`/ziwei/knowledge/[star]/[topic]` | `app/knowledge/**` | 面板「百科」 |
| `/ziwei`、`/ziwei/` | `app/page.tsx` | 308/307 重定向到 `/ziwei/chart`（插件内没有落地页） |

`/api/interpret`（应用自带的 AI 解读接口）**已删除**：解读只走插件的 `/ziwei/ai` → DSH 模型。

## 排盘页（`app/chart/page.tsx`，约 400 行）

这是唯一重度改造过的页面。自上而下：

1. **工具条**：`← 重新起盘`、`分享命盘`、`最近生辰 ▾`（列最近 5 条，点一条换盘）、
   `复制盘面摘要`（`digestChart` 文本进剪贴板）、生辰状态（「已恢复上次记住的生辰 · 忘记」／
   「正在查看分享链接里的命盘」）。表单页顶部还有「最近用过」胶囊，同样来自
   `/ziwei/birth` 的 history。
2. **概览条 + 抽屉**：常驻一行 `命宫 · 主星 | 五行局 | 格局 N 个`，点「展开命盘概览」
   在盘面上方展开 `ChartSummary`（命格总览 / 本命四化 / 格局识别），再点收起。
3. **盘面** `ChartBoard`：4×4 宫格，本命/大限/流年三视图（`TimeNav` 在 `ChartBoard` 内部），
   点宫位看三方四正，点星曜弹 `StarDetailPanel`。
4. **右栏** `InsightPanel`：六个主题 tab（命格/感情/事业/财运/健康/性格）+ 自动生成解读 +
   底部追问框；数据走 `/ziwei/ai`。
5. **分享弹层** `ShareModal` + `ShareCardCanvas`：分享卡（html2canvas 现场生成 PNG）+
   带生辰参数的链接 `?b=YYYY-M-D-H&g=m|f`。

布局约束（改版面的注意点）：

- `main` 是 `height:100vh` 的 flex 列，盘面容器 `flex:1; min-height:0`，4×4 网格行高 `1fr`
  —— 这样内嵌到面板里会撑满 iframe，不会在下面留一大片空白；
- 右栏宽度 `minmax(0,420px)`；「追问」按钮 `whiteSpace:nowrap`，不允许换行；
- 底部输入区的 `paddingBottom/paddingRight` 由宿主推来的 `dsh-ziwei:insets` 动态加宽，
  给 dsh-pet 浮层让位（`<main data-pet-insets="bottom,right">` 供验收断言）。

## 生辰存储（`lib/birth-storage.ts`）

- `loadSavedBirth()` → `GET /ziwei/birth`，取 `current` 归一化；接口不可用返回 `null`（不阻断排盘）。
- `saveBirth(info, form)` → `POST /ziwei/birth`，失败时回本地对象，排盘照常进行。
- `clearSavedBirth()` → `DELETE /ziwei/birth`。
- 每次加载顺手 `localStorage.removeItem('ziwei-birth-v1')`（清掉旧版本浏览器存储）。
- 分享链接里的生辰**优先级高于**服务端记住的生辰，且**不会**写回配置。

## 组件清单（`components/`）

| 组件 | 职责 | 备注 |
| --- | --- | --- |
| `BirthForm` | 出生信息表单（年/月/日/时辰/性别/地点） | `onFormSave` 把表单快照交给父级；`initialData` 回填；`hideSubmit` 隐藏提交 |
| `ChartBoard` | 4×4 盘面、本命/大限/流年 | 透传 `onStarSelect` / `onPalaceSelect`；内含 `TimeNav` |
| `PalaceCell` | 单个宫位 | 主星带 `data-ziwei-star={star.name}`（验收锚点）；星曜亮度/四化配色走 CSS 变量 |
| `ChartSummary` | 命格总览 + 本命四化 + 格局识别卡片 | 概览抽屉里用；数据来自 `getMingGongSummary` / `detectPatterns` |
| `StarDetailPanel` | 点星看解释 | 古籍原文 + 倪师解读 + 事业/感情/财运 |
| `ShareModal` / `ShareCardCanvas` | 分享图与分享链接 | html2canvas 生成 PNG；`captureShareCard()` / `downloadDataURL()` |
| `InsightPanel` | 右栏解读面板 | 六 tab、SSE 流式、`RichText` 极简渲染、`petInsets` 让位 |
| `ThemeProvider` | 主题（浅/深，默认浅色） | 读 `?theme=` 强制指定；监听 `dsh-ziwei:theme` 消息 |
| `TimeNav` | 时间导航（本命/大限/流年） | 被 `ChartBoard` 内部引用 |

已删除：`PatternsCard`（与概览里的「格局识别」重复）、`FamousPersonCard`（依赖 server-only
且没有入口）、`ChatPanel`（自带 AI 面板）、`StarField` + `ScrollIntro`（落地页/开场动画专用）。

## 内核模块清单（`lib/ziwei/`，合计约 5300 行）

| 模块 | 作用 |
| --- | --- |
| `algorithm.ts`（662 行） | 排盘主流程：基于 `iztro`，产出 `ZiweiChart`（十二宫、星曜、四化、大限…） |
| `types.ts` | 全部类型：`BirthInfo` / `LunarInfo` / `Star` / `Palace` / `ZiweiChart` |
| `constants.ts` | 天干地支、时辰、星曜名等常量 |
| `sihua.ts`（276 行） | 四化：年干/大限/流年/流月/流日/流时 |
| `patterns.ts`（1121 行） | 格局识别（严格古书条件）+ 命宫总览摘要 `getMingGongSummary` |
| `cities.ts`（704 行） | 城市经纬度表（真太阳时用） |
| `true-solar-time.ts` | 真太阳时统一计算 |
| `clock-adjust.ts` | 出生钟表时间平移（夏令时/当年时区） |
| `dst-cn.ts` | 中国大陆夏令时判定（逐字对齐主流口径） |
| `lunar-solar.ts` / `lunar-javascript.d.ts` | 农历⇄公历换算（只做历法，不做命理） |
| `shier-shen.ts` | 将前十二神 / 岁前十二神 |
| `school-config.ts` / `school-data.ts` / `school-tables.generated.ts` | 9 类排盘流派开关与安星整数表（生成文件勿手改） |
| `digest.ts`（91 行） | **为插件新加**：把 `ZiweiChart` 压成给模型看的纯文本摘要 |
| `db-analysis.ts` | 断语库占位（`STAR_DB` 为空；逐宫断语改由 DSH 的模型现场生成） |
| `famous.ts` | 名人命盘样本（只被回归测试用；页面已无入口） |
| `share.ts` / `yunxian-context.ts` | 分享参数编解码、运限视图上下文 |

> 上游开源项目带来的 `.github/`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`DATASET-LICENSE`、
> `README.en.md`、`docs/`（1848 条天纪引文语料）、`verification-birth/`、以及根目录那份开源
> README，都是「作为独立开源仓库」才需要的东西，已随本次改造删除；`LICENSE`（MIT）保留。

## 主题与设计 token（`app/globals.css`）

- `:root` 是浅色默认，`[data-theme="dark"]` 覆盖为深色；组件里普遍有 `theme === 'dark' ? … : …`。
- 命盘专用变量（全仓库只有这里定义）：
  `--t-bg/--t-card/--t-surface/--t-text/--t-text1/--t-text2/--t-faint/--t-border/--t-border-acc/--t-gold`、
  `--star-bright/--star-normal/--star-dim/--star-lucky/--star-sha`、`--board-shadow`。
- 深色下星曜色沿用 Tailwind 色阶；浅色下星曜换更深一档（白底可读），并且有一层
  `[data-theme="light"]` 的 `.text-amber-*/sky-*/emerald-*/red-*/purple-*/slate-*` 覆盖，
  免得白底上出现发飘的浅色文字。
- 内嵌时主题由宿主决定：插件把 `?theme=light|dark` 拼进 iframe URL，并在宿主主题变化时
  `postMessage({type:'dsh-ziwei:theme', theme})`。

## 回归测试（`scripts/regression/`）

```bash
cd app && npm test        # 10 个 tsx 脚本，逐个跑，全部 ✓ 才算过
```

覆盖：盘面完整性、996/DST 边界、钟表时间平移、节气四柱立春边界、红鸾天喜映射、
名人样本时辰一致性、iztro 时辰索引边界、公历日期存在性、同宫双四化、命名中立性
（111 个文件里不能出现第三方排盘软件名）。

插件层验收（`verify.mjs`，38 项）和生辰持久化回归（`app/test-persistence.mjs`，16 项）
在 [deploy.md](./deploy.md#验收) 里。

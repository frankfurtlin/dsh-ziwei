/**
 * dsh-ziwei 端到端验收脚本。
 *
 * 用法：
 *   node verify.mjs --url "http://127.0.0.1:3080/?token=..." [--out dir] [--no-chart]
 *
 * 检查项（全部为真实浏览器行为，不是静态代码检查）：
 *   1. 侧栏出现「紫微斗数」入口，且顺序落在 Automation tasks 与 Skill Center 之间；
 *   2. 点击后主面板出现内嵌排盘应用（iframe 同源、可渲染）；
 *   3. /ziwei/ 未带登录态时被 DSH 鉴权闸门挡住（401），带登录态 200；
 *   4. 在 iframe 内起盘后，插件工具条收到盘面摘要，「让 DSH 解读」按钮变为可用；
 *   5. 截图留证 + 输出 JSON 报告。
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire('/root/workspace/hermes-site/tools/node_modules/')
const { chromium } = require('playwright')

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}
const url = arg('url', process.env.DSH_WEB_URL || '')
const outDir = arg('out', '/root/workspace/plugins/dsh-ziwei/verification')
const skipChart = args.includes('--no-chart')
if (!url) {
  console.error('缺少 --url（带 token 的 DSH Web 地址）')
  process.exit(2)
}

const report = { url: url.replace(/token=[^&]+/, 'token=***'), startedAt: new Date().toISOString(), checks: [] }
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  await mkdir(outDir, { recursive: true })

  // ── 0. 未登录访问 /ziwei/ 必须被挡 ──
  const anon = await browser.newContext({ ignoreHTTPSErrors: true })
  const anonRes = await anon.request.get(new URL('ziwei/', url).href)
  check('未登录访问 /ziwei/ 被拒绝', anonRes.status() === 401, `HTTP ${anonRes.status()}`)
  await anon.close()

  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'], ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 全新 DSH_HOME 上会弹 "Get started" 欢迎弹层，它带的透明遮罩会拦截侧栏点击；
  // 生产环境里早已关闭，这里按 Escape 关掉以保证脚本可重复执行。
  await page.keyboard.press('Escape').catch(() => {})

  // 生辰会被应用记住（服务端配置文件，宿主上 ~/.dsh/ziwei/birth.json）；
  // 上次验收起过盘，不清掉的话这次进排盘页会直接恢复旧盘、看不到表单。
  // 这里先 DELETE 保证可重复执行，同时清掉早期版本留在浏览器里的旧记录。
  await page
    .evaluate(() => window.localStorage.removeItem('ziwei-birth-v1'))
    .catch(() => {})
  // 生产实例上可能已经有用户自己的生辰记录：验收会写入 1990-6-15，
  // 所以先快照，验收断言做完立刻写回去，别把用户数据冲掉。
  const birthBefore = await context.request
    .get(new URL('ziwei/birth', url).href)
    .then((res) => (res.ok() ? res.json() : null))
    .catch(() => null)
  const birthUrl = new URL('ziwei/birth', url).href
  const clearBirth = async (scope) => {
    const target = scope === 'all' ? `${birthUrl}?scope=all` : birthUrl
    const res = await context.request.delete(target).catch(() => null)
    return res ? res.status() : 0
  }
  const readBirth = async () => {
    const res = await context.request.get(birthUrl).catch(() => null)
    return res && res.ok() ? res.json().catch(() => null) : null
  }
  const postBirth = async (info, form) => {
    const res = await context.request.post(birthUrl, { data: { info, form } }).catch(() => null)
    return res ? res.status() : 0
  }
  // 完整还原：先把库清空，再按「旧→新」回放历史，最后写回 current。
  // 以前只写回 current，用户的「最近生辰」历史被验收悄悄抹掉过。
  const restoreBirths = async (snapshot) => {
    await clearBirth('all')
    const history = Array.isArray(snapshot?.history) ? [...snapshot.history].reverse() : []
    for (const record of history) await postBirth(record.info, record.form)
    if (snapshot?.current?.info) await postBirth(snapshot.current.info, snapshot.current.form)
    return history.length
  }

  // DELETE 语义：默认只清「当前记录」，历史保留；?scope=all 才真清空。
  await clearBirth('all')
  await postBirth({ year: 1955, month: 5, day: 5, hour: 3, gender: 'male' })
  await postBirth({ year: 1956, month: 6, day: 6, hour: 4, gender: 'female' })
  const forgetStatus = await clearBirth()
  const afterForget = await readBirth()
  check(
    '「忘记」只清当前记录、保留历史列表',
    forgetStatus === 200 &&
      afterForget?.current === null &&
      Array.isArray(afterForget?.history) &&
      afterForget.history.length >= 2,
    `HTTP ${forgetStatus} current=${JSON.stringify(afterForget?.current ?? null)} history=${afterForget?.history?.length ?? 'n/a'}`,
  )
  const birthStatus = await clearBirth('all')
  check('清空服务端生辰记录（可重复执行）', birthStatus === 200, `HTTP ${birthStatus}`)

  // ── 1. 侧栏入口存在且位置正确 ──
  // 用 aria-label 定位而不是可见文字：验收机（服务器）通常没装中文字体，
  // 文字会渲染成豆腐块，但 aria-label 与 DOM 文本始终是正确的。
  const icon = page.locator('button[aria-label="紫微斗数"]')
  await icon.waitFor({ state: 'visible', timeout: 30000 })
  const sidebarText = await page.locator('body').innerText()
  const indexZiwei = sidebarText.indexOf('紫微斗数')
  const indexSchedule = sidebarText.indexOf('Automation tasks')
  const indexSkill = sidebarText.indexOf('Skill Center')
  check('侧栏出现「紫微斗数」入口', indexZiwei !== -1)
  check(
    '入口位于「Automation tasks」与「Skill Center」之间',
    indexSchedule !== -1 && indexSkill !== -1 && indexSchedule < indexZiwei && indexZiwei < indexSkill,
    `schedule=${indexSchedule} ziwei=${indexZiwei} skill=${indexSkill}`,
  )

  await page.screenshot({ path: path.join(outDir, '01-sidebar.png') })

  // ── 2. 点击进入主面板 ──
  // 侧栏行在鼠标悬停时会浮出一层 tooltip 遮罩，headless 下偶尔拦截点击；
  // 先常规点击，被遮罩挡住就退回 force click（真实浏览器里点的是同一个按钮）。
  // 全新 DSH_HOME 会先弹「Get started」欢迎层（透明 mask 会吞掉点击）；
  // 第一次交互前后都可能再弹一次，所以做成可反复调用的关闭函数。
  async function dismissWelcome() {
    const close = page.locator('div[role="presentation"] button[aria-label="Close"]').first()
    if (await close.count()) {
      await close.click({ force: true }).catch(() => {})
      await page.waitForTimeout(300)
      return true
    }
    return false
  }
  await page.keyboard.press('Escape').catch(() => {})
  await dismissWelcome()
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    try {
      await icon.click({ timeout: 4000 })
    } catch {
      await icon.click({ force: true }).catch(() => {})
      await page.mouse.click(140, 215)
    }
    opened = await page
      .locator('iframe[title="紫微斗数排盘"]')
      .waitFor({ state: 'visible', timeout: 6000 })
      .then(() => true)
      .catch(() => false)
  }
  check('点击侧栏入口打开主面板', opened)
  const iframe = page.locator('iframe[title="紫微斗数排盘"]')
  await iframe.waitFor({ state: 'visible', timeout: 30000 })
  const frame = page.frameLocator('iframe[title="紫微斗数排盘"]')
  await frame.locator('button[type="submit"]').first().waitFor({ state: 'visible', timeout: 60000 })
  const frameUrl = page.frames().find((f) => f.url().includes('/ziwei/'))?.url() ?? ''
  check('主面板内嵌排盘应用渲染成功', frameUrl.includes('/ziwei/'), frameUrl)

  // 内嵌页配色要跟外壳一致（外壳浅色 → 排盘页 data-theme="light"）
  const hostDark = await page.evaluate(() =>
    (getComputedStyle(document.documentElement).colorScheme || '').includes('dark'),
  )
  const frameTheme = await page
    .frames()
    .find((f) => f.url().includes('/ziwei/'))
    ?.evaluate(() => document.documentElement.getAttribute('data-theme'))
  check(
    '内嵌页配色跟随 DSH 外壳',
    frameTheme === (hostDark ? 'dark' : 'light'),
    `host=${hostDark ? 'dark' : 'light'} iframe=${frameTheme}`,
  )
  await page.screenshot({ path: path.join(outDir, '02-panel.png') })

  // ── 3. 带登录态访问 /ziwei/ 是 200 ──
  const authedRes = await context.request.get(new URL('ziwei/', url).href)
  check('登录态访问 /ziwei/ 返回 200', authedRes.status() === 200, `HTTP ${authedRes.status()}`)

  // ── 4. 在 iframe 内起盘 → 盘面桥接 → 按钮可用 ──
  if (!skipChart) {
    await dismissWelcome()
    const selects = frame.locator('select')
    await selects.nth(0).selectOption('1990')
    await selects.nth(1).selectOption('6')
    await selects.nth(2).selectOption('15')
    await selects.nth(5).selectOption('9')
    await selects.nth(6).selectOption('30')
    await frame.locator('button[type="submit"]').click()
    await frame.locator('text=重新起盘').first().waitFor({ state: 'visible', timeout: 60000 })

    const askButton = page.locator('button', { hasText: '让 DSH 解读' }).first()
    await page
      .locator('text=已读取当前盘面')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {})
    check('iframe 内起盘成功', true)

    // 竖向空间利用：排盘页要撑满 iframe（用户反馈「下面还有很多高度」）
    const layout = await page.evaluate(() => {
      const f = document.querySelector('iframe[title="紫微斗数排盘"]')
      const fr = f ? f.getBoundingClientRect() : null
      return fr ? { frameH: Math.round(fr.height) } : null
    })
    const innerLayout = await page
      .frames()
      .find((candidate) => candidate.url().includes('/ziwei/'))
      ?.evaluate(() => {
        const main = document.querySelector('main')
        const board = document.querySelector('.grid.rounded-xl')
        const aside = document.querySelector('aside')
        return {
          viewportH: window.innerHeight,
          mainH: main ? Math.round(main.getBoundingClientRect().height) : 0,
          boardH: board ? Math.round(board.getBoundingClientRect().height) : 0,
          asideH: aside ? Math.round(aside.getBoundingClientRect().height) : 0,
          insets: main ? main.getAttribute('data-pet-insets') : null,
        }
      })
    check(
      '排盘页纵向撑满可用高度',
      Boolean(innerLayout) &&
        layout &&
        innerLayout.mainH >= layout.frameH - 4 &&
        innerLayout.boardH >= 520 &&
        innerLayout.asideH >= layout.frameH - 120,
      innerLayout ? `main=${innerLayout.mainH} board=${innerLayout.boardH} aside=${innerLayout.asideH} frame=${layout?.frameH}` : 'n/a',
    )
    // 宠物是宿主层异步挂载的，同步可能晚一拍：轮询最多 15s
    const readInsets = async () =>
      (await page
        .frames()
        .find((candidate) => candidate.url().includes('/ziwei/'))
        ?.evaluate(() => document.querySelector('main')?.getAttribute('data-pet-insets'))
        .catch(() => null)) ?? null
    let insets = await readInsets()
    for (let i = 0; i < 15 && (!insets || insets === '0,0'); i += 1) {
      await page.waitForTimeout(1000)
      insets = await readInsets()
    }
    check('插件把宠物遮挡区域同步给了内嵌页', Boolean(insets && insets !== '0,0'), insets ?? 'n/a')

    // 生辰记忆：起盘后应写进宿主上的配置文件（不是浏览器存储）
    const birthRes = await context.request.get(new URL('ziwei/birth', url).href).catch(() => null)
    const birthPayload = birthRes && birthRes.ok() ? await birthRes.json().catch(() => null) : null
    const current = birthPayload?.current
    check(
      '起盘后生辰被写进服务端配置文件',
      current?.info?.year === 1990 && current?.info?.month === 6 && current?.info?.day === 15,
      current ? `${current.info.year}-${current.info.month}-${current.info.day}` : JSON.stringify(birthPayload).slice(0, 80),
    )
    check(
      '配置文件里带表单快照（重新起盘可回填）',
      Boolean(current?.form?.year),
      current?.form ? `form.year=${current.form.year}` : 'no form',
    )
    const legacyLocal = await page
      .evaluate(() => window.localStorage.getItem('ziwei-birth-v1'))
      .catch(() => 'unknown')
    check('不再往浏览器 localStorage 写生辰', legacyLocal === null, String(legacyLocal))

    // 把验收污染掉的用户记录完整还原（current + 历史列表）
    const restoredCount = await restoreBirths(birthBefore)
    const afterRestore = await readBirth()
    const expectedCurrent = birthBefore?.current?.info?.year ?? null
    const actualCurrent = afterRestore?.current?.info?.year ?? null
    check(
      '验收后完整恢复了原有的生辰记录（含最近列表）',
      restoredCount >= (birthBefore?.history?.length ?? 0) &&
        actualCurrent === expectedCurrent &&
        (afterRestore?.history?.length ?? 0) >= (birthBefore?.history?.length ?? 0),
      `restored=${restoredCount} history=${afterRestore?.history?.length ?? 'n/a'} current=${actualCurrent}`,
    )

    // 解读面板：不再是应用自带 AI，而是插件 host 半用 DSH 模型生成（/ziwei/ai）
    const frameText = await frame.locator('body').innerText().catch(() => '')
    check(
      '排盘页渲染「命理解读」面板（由 DSH 模型生成）',
      /命理解读/.test(frameText) && /由 DSH 模型生成/.test(frameText),
      `hasPanel=${/命理解读/.test(frameText)}`,
    )
    const apiRes = await page.request.get(new URL('ziwei/api/interpret', page.url()).href)
    check('应用里旧的 AI 接口已移除', apiRes.status() === 404, `HTTP ${apiRes.status()}`)

    const panelText = async () => {
      const text = await frame.locator('body').innerText()
      return text.slice(text.indexOf('命理解读'))
    }
    // 面板是流式的：等到「追问」按钮重新出现（说明这一轮结束）且正文稳定
    // 采样面板文本长度的增长节奏，用来验证「吐词平顺」：平滑之后应该每 100~200ms
    // 都有新字出现，而不是一口气糊一大段、然后再干等。
    const streamSamples = []
    const waitReading = async (mustMatch, timeoutMs = 150000) => {
      const started = Date.now()
      let last = ''
      let lastIdleCheck = 0
      let idle = false
      while (Date.now() - started < timeoutMs) {
        await page.waitForTimeout(150)
        const text = await panelText()
        streamSamples.push({ at: Date.now() - started, len: text.length })
        // 追问按钮出现 = 这一轮流结束（每 900ms 才查一次，别把采样拖慢）
        if (Date.now() - lastIdleCheck > 900) {
          lastIdleCheck = Date.now()
          idle = (await frame.locator('button:has-text("追问")').count()) > 0
        }
        if (idle && text === last && mustMatch.test(text)) return text
        last = text
      }
      return last
    }

    const reading = await waitReading(/【命格定性】/)
    {
      // 只看「开始出字之后、还没结束」的那一段
      const grows = streamSamples.filter((item, index) => index > 0 && item.len > streamSamples[index - 1].len)
      const firstGrow = grows.length ? grows[0].at : null
      let maxStall = 0
      for (let i = 1; i < grows.length; i += 1) {
        maxStall = Math.max(maxStall, grows[i].at - grows[i - 1].at)
      }
      check(
        '首字延迟在可接受范围（<20s）',
        firstGrow !== null && firstGrow < 20000,
        `first_grow=${firstGrow}ms`,
      )
      check(
        '解读是匀速吐出来的（最长停顿 <1.2s）',
        grows.length > 5 && maxStall < 1200,
        `increments=${grows.length} max_stall=${maxStall}ms`,
      )
    }
    check('右侧面板自动生成了命格解读', /【命格定性】/.test(reading), `len=${reading.length}`)
    check(
      '解读由 DSH 模型生成，没有回退报错',
      !/解读失败|稍后再试|没接通|Cannot read|no credential|MissingSessionID/.test(reading),
      reading.slice(-120).replace(/\s+/g, ' '),
    )
    await page.waitForTimeout(1000)
    await page.screenshot({ path: path.join(outDir, '03-chart-bridged.png'), fullPage: false })

    // 六个 tab 之一：感情 → 换一套解读
    await frame.locator('button:has-text("感情")').first().click({ force: true })
    const love = await waitReading(/【感情格局】/)
    check('切换「感情」标签会重新生成对应解读', /【感情格局】/.test(love), `sections=${(love.match(/【[^】]+】/g) || []).length}`)

    // 追问：必须走真实点击，force 会绕过命中测试、测不出被浮层遮挡
    await frame.locator('input[placeholder*="继续追问"]').fill('今年适合换工作吗？')
    const petBox = await page.locator('[aria-label="pet"]').first().boundingBox().catch(() => null)
    const iframeBox = await page.locator('iframe[title="紫微斗数排盘"]').boundingBox().catch(() => null)
    const realFrame = page.frames().find((item) => item.url().includes('/ziwei/'))
    const btnBox = await realFrame.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.innerText.trim() === '追问')
      if (!btn) return null
      const rect = btn.getBoundingClientRect()
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    })
    let overlapped = false
    if (petBox && iframeBox && btnBox) {
      const left = iframeBox.x + btnBox.x
      const top = iframeBox.y + btnBox.y
      const right = left + btnBox.w
      const bottom = top + btnBox.h
      overlapped = !(
        right < petBox.x ||
        petBox.x + petBox.width < left ||
        bottom < petBox.y ||
        petBox.y + petBox.height < top
      )
    }
    check('「追问」按钮没有被宠物浮层盖住', !overlapped)
    await frame.locator('button:has-text("追问")').first().click({ timeout: 15000 })
    const followed = await waitReading(/今年适合换工作/)
    check(
      '追问能带着盘面继续解读',
      /今年适合换工作/.test(followed) && followed.replace(/\s+/g, '').length > 900,
      `len=${followed.length}`,
    )
    await page.screenshot({ path: path.join(outDir, '05-panel-reading.png') })

    // ── 6. 命盘总览抽屉（原来闲置的 ChartSummary 接回来了）──
    await frame.locator('[data-ziwei-brief-toggle]').click()
    const briefBody = frame.locator('[data-ziwei-brief-body]')
    await briefBody.waitFor({ state: 'visible', timeout: 15000 })
    const briefText = await briefBody.innerText()
    check(
      '命盘概览抽屉展开后有命格总览与格局识别',
      /命格总览/.test(briefText) && /格局识别/.test(briefText) && /本命四化/.test(briefText),
      `len=${briefText.length}`,
    )
    // 概览卡片有入场动画（framer-motion），截图前等一下，否则拍到空白
    await page.waitForTimeout(900)
    await page.screenshot({ path: path.join(outDir, '06-brief.png') })
    await frame.locator('[data-ziwei-brief-toggle]').click()
    await briefBody.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
    check('再点一次能收起命盘概览', (await frame.locator('[data-ziwei-brief-body]').count()) === 0)

    // ── 7. 点星看解释（StarDetailPanel 接回来了）──
    await frame.locator('[data-ziwei-star]').first().click({ timeout: 15000 })
    const starPanel = frame.locator('[data-ziwei-star-detail]')
    await starPanel.waitFor({ state: 'visible', timeout: 15000 })
    const starText = await starPanel.innerText()
    check('点星曜弹出星曜详情（古籍 + 倪师解读）', starText.length > 120 && /(倪师|古诀)/.test(starText), `len=${starText.length}`)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(outDir, '07-star-detail.png') })
    await starPanel.locator('button').first().click({ force: true }).catch(() => {})
    await starPanel.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})

    // ── 8. 分享图（ShareModal 接回来了）──
    await frame.locator('[data-ziwei-share]').click()
    await frame.locator('text=下载分享图').first().waitFor({ state: 'visible', timeout: 15000 })
    const shareText = await frame.locator('body').innerText()
    check(
      '分享命盘弹层能打开并渲染分享卡',
      /下载分享图/.test(shareText) && /复制命盘链接/.test(shareText) && /倪海厦正宗/.test(shareText),
      `card=${/倪海厦正宗/.test(shareText)}`,
    )
    const shareUrlAttr = (await frame.locator('[data-ziwei-share]').getAttribute('data-ziwei-share-url')) || ''
    check('分享链接里带着生辰参数', /b=1990-6-15-5/.test(shareUrlAttr), shareUrlAttr.slice(0, 90))
    // 分享图由 html2canvas 现场生成并触发下载，这里真实点一次，等浏览器下载事件
    let shareDialog = ''
    page.on('dialog', async (dialog) => {
      shareDialog = dialog.message()
      await dialog.dismiss().catch(() => {})
    })
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
    await frame.locator('button:has-text("下载分享图")').click().catch(() => {})
    const shareDownload = await downloadPromise
    check(
      '能生成并下载分享图',
      !!shareDownload && /紫微命盘/.test(shareDownload.suggestedFilename()),
      shareDownload ? shareDownload.suggestedFilename() : shareDialog || '没有触发下载',
    )
    await page.screenshot({ path: path.join(outDir, '08-share.png') })
    await frame.locator('button:has-text("×")').first().click({ force: true }).catch(() => {})

    // ── 8.5 最近生辰：服务端记着的生辰能直接复用 ──
    const recentButton = frame.locator('[data-ziwei-recent]')
    if (await recentButton.count()) {
      await recentButton.click()
      const recentList = frame.locator('[data-ziwei-recent-list]')
      await recentList.waitFor({ state: 'visible', timeout: 10000 })
      const recentText = await recentList.innerText()
      check('「最近生辰」列出服务端记住的生辰', /1990/.test(recentText) && /时/.test(recentText), recentText.replace(/\s+/g, ' ').slice(0, 60))
      // 点第一条：应该换成那张盘（生辰相同，至少工具条还在、盘面仍在）
      await recentList.locator('button').first().click({ force: true })
      await page.waitForTimeout(800)
      check('点「最近生辰」能直接换成那张盘', (await frame.locator('[data-ziwei-brief]').count()) > 0)
    } else {
      check('「最近生辰」入口存在', false, '没有找到 [data-ziwei-recent]')
    }

    // ── 8.6 复制盘面摘要（方便直接贴进 DSH 会话）──
    const copyButton = frame.locator('[data-ziwei-copy]')
    check('工具条有「复制盘面摘要」按钮', (await copyButton.count()) > 0)
    await copyButton.click()
    await page.waitForTimeout(600)
    const copiedText = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
    check(
      '复制出来的摘要含命盘要点',
      /【基本信息】/.test(copiedText) && /十二宫/.test(copiedText) && copiedText.length > 400,
      `len=${copiedText.length}`,
    )

    // ── 9. 分享链接回放：另开一个页面直接还原同一张盘 ──
    const sharedPage = await context.newPage()
    try {
      await sharedPage.goto(new URL('ziwei/chart?b=1985-3-20-7&g=m', url).href, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await sharedPage.locator('[data-ziwei-brief]').waitFor({ state: 'visible', timeout: 40000 })
      const sharedBody = await sharedPage.locator('body').innerText()
      await sharedPage.locator('[data-ziwei-brief-toggle]').click()
      const sharedBrief = await sharedPage
        .locator('[data-ziwei-brief-body]')
        .innerText()
        .catch(() => '')
      check(
        '分享链接能直接还原同一张命盘（1985-3-20）',
        /正在查看分享链接里的命盘/.test(sharedBody) && /1985/.test(sharedBrief),
        `brief=${sharedBrief.replace(/\s+/g, ' ').slice(0, 40)}`,
      )
    } finally {
      await sharedPage.close().catch(() => {})
    }

    // ── 10. 面板二级入口：古籍 / 百科 / 回到排盘 ──
    const currentFrameUrl = () => page.frames().find((item) => item.url().includes('/ziwei/'))?.url() ?? ''
    async function switchPanelView(key, expectedPath) {
      await page.locator(`button[data-dsh-ziwei-tab="${key}"]`).click({ force: true })
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const href = currentFrameUrl()
        if (href.includes(expectedPath)) return href
        await page.waitForTimeout(250)
      }
      return currentFrameUrl()
    }
    const hemingUrl = await switchPanelView('heming', '/ziwei/heming')
    check('面板能切到「合盘」', hemingUrl.includes('/ziwei/heming'), hemingUrl)
    // 合盘页：填双方生辰 → 点「开始合盘分析」→ 应由 DSH 模型流式出解读
    const hemingFrame = page.frames().find((item) => item.url().includes('/ziwei/heming'))
    if (hemingFrame) {
      const selects = hemingFrame.locator('select')
      const pairs = [[0, '1990'], [1, '6'], [2, '15'], [5, '9'], [6, '30'], [7, '1992'], [8, '3'], [9, '8'], [12, '5'], [13, '0']]
      for (const [index, value] of pairs) await selects.nth(index).selectOption(value)
      await hemingFrame.locator('button', { hasText: '开始合盘分析' }).first().click()
      const box = hemingFrame.locator('[data-heming-analysis]')
      const deadline = Date.now() + 150000
      let hemingText = ''
      let stableFor = 0
      let lastLen = -1
      while (Date.now() < deadline) {
        hemingText = await box.innerText().catch(() => '')
        // 流式结束的判据：追问框出现（分析完成后才渲染），或连续 3 次长度不变
        const done = /针对此次合盘继续追问/.test(await hemingFrame.locator('body').innerText().catch(() => ''))
        stableFor = hemingText.length === lastLen ? stableFor + 1 : 0
        lastLen = hemingText.length
        if (hemingText.length > 900 && (done || stableFor >= 3)) break
        await page.waitForTimeout(2000)
      }
      check(
        '合盘分析由 DSH 模型生成',
        hemingText.length > 600 && !/分析暂时不可用|解读服务|没有返回内容/.test(hemingText),
        `len=${hemingText.length}`,
      )
      await page.screenshot({ path: path.join(outDir, '10-panel-heming.png') })
    } else {
      check('合盘分析由 DSH 模型生成', false, '没有找到合盘 iframe')
    }
    const libraryUrl = await switchPanelView('library', '/ziwei/library')
    check('面板能切到「古籍」', libraryUrl.includes('/ziwei/library'), libraryUrl)
    const knowledgeUrl = await switchPanelView('knowledge', '/ziwei/knowledge')
    check('面板能切到「百科」', knowledgeUrl.includes('/ziwei/knowledge'), knowledgeUrl)
    const innerPage = page.frames().find((item) => item.url().includes('/ziwei/'))
    const knowledgeText = await innerPage?.locator('body').innerText().catch(() => '')
    check('百科页在内嵌环境里渲染出内容', (knowledgeText || '').length > 200, `len=${(knowledgeText || '').length}`)
    await page.screenshot({ path: path.join(outDir, '09-panel-knowledge.png') })
    const backUrl = await switchPanelView('chart', '/ziwei/chart')
    check('能切回「排盘」', backUrl.includes('/ziwei/chart'), backUrl)
  }

  // ── 5. 「让 DSH 解读」→ 新开会话 + 盘面 prompt 进输入框（--ask 才跑）──
  if (args.includes('--ask')) {
    const askButton = page.locator('button', { hasText: '让 DSH 解读' }).first()
    await dismissWelcome()
    await askButton.click({ force: true })
    // 插件在新会话打开后把命盘 prompt 插进 Lexical 草稿；同时写剪贴板作为兜底。
    const draft = await page
      .waitForFunction(
        () => {
          const nodes = [...document.querySelectorAll('[contenteditable="true"]'), ...document.querySelectorAll('textarea')]
          const text = nodes.map((node) => node.value ?? node.innerText).join('\n')
          return /紫微斗数/.test(text) && /命盘/.test(text) ? text : false
        },
        undefined,
        { timeout: 25000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => '')
    const clipboard = await page
      .evaluate(() => navigator.clipboard.readText().catch(() => ''))
      .catch(() => '')
    check('「让 DSH 解读」打开新会话', /New Session|Into the Unknown|Standard mode/.test(await page.locator('body').innerText()))
    check('会话草稿已填入命盘 prompt', /紫微斗数/.test(draft) && /命盘/.test(draft), draft.replace(/\s+/g, ' ').slice(0, 80))
    check('命盘 prompt 同时写入剪贴板（兜底）', /紫微斗数/.test(clipboard), clipboard.slice(0, 40))
    report.draft = String(draft).slice(0, 400)
    await page.screenshot({ path: path.join(outDir, '04-ask-draft.png') })
  }

  // ---- 生辰接口不泄漏本机路径 ----
  {
    const birthInfo = await page.evaluate(async () => {
      const res = await fetch('/ziwei/birth', { headers: { accept: 'application/json' } })
      return { status: res.status, body: await res.json().catch(() => null) }
    })
    check(
      '生辰接口只回相对位置，不泄漏本机绝对路径',
      birthInfo.status === 200 && birthInfo.body?.file === 'ziwei/birth.json',
      `status=${birthInfo.status} file=${birthInfo.body?.file}`,
    )
  }

  const fatalErrors = consoleErrors.filter((text) => !/Failed to load resource/.test(text))
  check('无控制台 JS 报错', fatalErrors.length === 0, fatalErrors.slice(0, 3).join(' | ') || 'clean')

  report.ok = report.checks.every((item) => item.ok)
} catch (error) {
  report.ok = false
  report.error = error && error.stack ? error.stack : String(error)
  console.error('验收异常：', error)
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.ok ? '\n全部检查通过 ✅' : '\n存在失败项 ❌（见 report.json）')
  process.exit(report.ok ? 0 : 1)
}

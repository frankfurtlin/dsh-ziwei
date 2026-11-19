// 生辰记忆（服务端配置文件）回归测试：
//   清空 → 起盘写配置 → 重载自动恢复 → 换一个浏览器上下文仍能恢复 →
//   生辰管理（列出全部 / 编辑单条 / 删除单条）→ 重新起盘回填 → 忘记清空 →
//   手机端（390×844）表单页 / 命盘页无横向溢出、管理弹层不出界。
//
// 用法（默认连 DSH 插件面板所在的实例，需要 token 才能过登录闸门）：
//   node test-persistence.mjs \
//     --url http://127.0.0.1:3099/ziwei/chart \
//     --token 52Eey... \
//     --shots /tmp/birth-verify
//
// 不带 --token 也可以直接测 Next 自己（此时没有 /ziwei/birth 接口，服务端断言会失败）。
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const require = createRequire('/root/workspace/hermes-site/tools/node_modules/');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const pick = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = pick('--url', 'http://127.0.0.1:8815/ziwei/chart');
const token = pick('--token', '');
const shotDir = pick('--shots', '/tmp/birth-verify');
const origin = new URL(url).origin;
const birthEndpoint = new URL('/ziwei/birth', origin).href;
const legacyKey = 'ziwei-birth-v1';

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(shotDir, { recursive: true });

// 同 verify.mjs：允许用 DSH_ZIWEI_CHROMIUM 指定本机已有的 headless shell
const chromiumExecutable = process.env.DSH_ZIWEI_CHROMIUM || undefined;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const readServer = async () => {
  const res = await context.request.get(birthEndpoint).catch(() => null);
  if (!res || !res.ok()) return { status: res ? res.status() : 0, payload: null };
  return { status: res.status(), payload: await res.json().catch(() => null) };
};

try {
  // 登录（token 只在首次打开时写 cookie）
  if (token) {
    await page.goto(`${origin}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  }
  // 生产实例上可能已有用户记录：先快照，跑完再写回去
  const before = await context.request
    .get(birthEndpoint)
    .then((res) => (res.ok() ? res.json() : null))
    .catch(() => null)

  // 干净起点：清服务端（含历史，用 scope=all）+ 清早期 localStorage
  const cleared = await context.request.delete(`${birthEndpoint}?scope=all`).catch(() => null);
  check('清空服务端生辰记录', Boolean(cleared && cleared.ok()), `HTTP ${cleared ? cleared.status() : 0}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate((k) => window.localStorage.removeItem(k), legacyKey);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]', { timeout: 20000 });
  check('清空后进入显示出生信息表单', await page.locator('button[type="submit"]').isVisible());

  // 预置三条历史记录，供后面的「生辰管理」验收：
  //   A 有表单快照 / C 是旧版没有快照的记录 / B 用来测单条删除（最后 POST，成为 current）
  const formSnapshot = (over) => ({
    name: '', year: '', month: '', day: '', clockHour: '0', clockMinute: '0', unknownTime: false,
    province: '', city: '', longitude: 120, gender: 'male', ...over,
  });
  const seed = async (info, form) => {
    const res = await context.request
      .post(birthEndpoint, { data: form ? { info, form } : { info } })
      .catch(() => null);
    return Boolean(res && res.ok());
  };
  const seededA = await seed(
    { year: 1981, month: 3, day: 4, hour: 0, gender: 'male', name: '管理甲' },
    formSnapshot({ name: '管理甲', year: '1981', month: '3', day: '4' }),
  );
  const seededC = await seed({ year: 1985, month: 5, day: 6, hour: 4, gender: 'male', name: '无表单旧记录' });
  const seededB = await seed(
    { year: 1972, month: 8, day: 9, hour: 6, gender: 'female', name: '管理乙' },
    formSnapshot({ name: '管理乙', year: '1972', month: '8', day: '9', clockHour: '12', gender: 'female' }),
  );
  const seededStore = await readServer();
  check(
    '预置历史记录成功（接口能读写多条记录）',
    seededA && seededC && seededB && seededStore.payload?.current?.info?.name === '管理乙' && seededStore.payload?.history?.length === 3,
    `current=${seededStore.payload?.current?.info?.name ?? 'n/a'} history=${seededStore.payload?.history?.length ?? 'n/a'}`,
  );
  // 重新打开：预置记录成了 current，先「重新起盘」回到表单再走原有流程
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("重新起盘")', { timeout: 20000 });
  await page.locator('button:has-text("重新起盘")').click();
  await page.waitForSelector('button[type="submit"]', { timeout: 20000 });

  // 起盘：1990-06-15 巳时
  const selects = page.locator('select');
  const count = await selects.count();
  await selects.nth(0).selectOption('1990');
  await selects.nth(1).selectOption('6');
  await selects.nth(2).selectOption('15');
  for (let i = 3; i < count; i += 1) {
    const n = i - 3;
    if (n === 2) await selects.nth(i).selectOption({ index: 9 });
    if (n === 3) await selects.nth(i).selectOption({ index: 30 }).catch(() => {});
  }
  await page.fill('input[type="text"] >> nth=0', '测试');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForSelector('button:has-text("重新起盘")', { timeout: 20000 });
  check('起盘后显示命盘', true);

  // 服务端配置文件应已落盘
  const afterSubmit = await readServer();
  const info = afterSubmit.payload?.current?.info;
  check('生辰写进了服务端配置文件', Boolean(info), info ? JSON.stringify(info) : `HTTP ${afterSubmit.status}`);
  check(
    '写入的年月日与输入一致',
    info?.year === 1990 && info?.month === 6 && info?.day === 15,
    info ? `${info.year}-${info.month}-${info.day}` : 'null',
  );
  check('表单快照一并保存（重新起盘可回填）', Boolean(afterSubmit.payload?.current?.form?.year));
  check(
    '生辰接口返回稳定 id（可定位单条记录）',
    /^b_[0-9a-f]{16}$/.test(afterSubmit.payload?.current?.id ?? ''),
    afterSubmit.payload?.current?.id ?? 'n/a',
  );
  check(
    '配置文件路径由宿主侧返回',
    typeof afterSubmit.payload?.file === 'string' &&
      afterSubmit.payload.file.endsWith('birth.json') &&
      !afterSubmit.payload.file.startsWith('/'),
    afterSubmit.payload?.file ?? 'n/a',
  );
  const legacy = await page.evaluate((k) => window.localStorage.getItem(k), legacyKey);
  check('不再往浏览器 localStorage 写生辰', legacy === null, String(legacy));

  // 重载：应自动恢复命盘，不再要求填表
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("重新起盘")', { timeout: 20000 });
  const hasForm = await page.locator('button[type="submit"]').count();
  check('重载后自动恢复上次命盘（无需重填）', hasForm === 0, `form buttons=${hasForm}`);
  check('显示「已恢复上次记住的生辰」提示', (await page.locator('text=已恢复上次记住的生辰').count()) > 0);
  await page.screenshot({ path: `${shotDir}/01-restored.png` });

  // 换一个全新浏览器上下文（相当于换设备/清缓存）：仍应恢复
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: 'zh-CN' });
  const otherPage = await otherContext.newPage();
  if (token) {
    await otherPage.goto(`${origin}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  }
  await otherPage.goto(url, { waitUntil: 'domcontentloaded' });
  await otherPage.waitForSelector('button:has-text("重新起盘")', { timeout: 20000 }).catch(() => {});
  const otherForm = await otherPage.locator('button[type="submit"]').count();
  check('全新浏览器上下文也能恢复（不依赖浏览器存储）', otherForm === 0, `form buttons=${otherForm}`);
  await otherContext.close();

  // ── 生辰管理：列出全部、编辑单条、删除单条 ──
  await page.locator('[data-ziwei-recent]').click();
  await page.locator('[data-ziwei-manage]').click();
  const manager = page.locator('[data-ziwei-manager]');
  await manager.waitFor({ state: 'visible', timeout: 10000 });
  const rows = manager.locator('[data-ziwei-manager-item]');
  const rowCount = await rows.count();
  check('生辰管理列出全部生辰（当前 + 历史）', rowCount === 4, `rows=${rowCount}`);
  const rowIds = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id') || ''));
  check(
    '列表每条记录都带稳定 id',
    rowIds.every((value) => /^b_[0-9a-f]{16}$/.test(value)),
    rowIds.join(','),
  );
  const currentRow = rows.filter({ hasText: '1990-06-15' });
  check('当前命盘的生辰标记为「当前」', (await currentRow.innerText()).includes('当前'));
  await page.screenshot({ path: `${shotDir}/04-manager.png` });

  // 编辑历史记录 A：表单回填 → 改名 → 保存，只替换这一条
  const editRow = rows.filter({ hasText: '1981-03-04' });
  await editRow.locator('[data-ziwei-manager-edit]').click();
  const editForm = manager.locator('[data-ziwei-manager-edit-form]');
  await editForm.waitFor({ state: 'visible', timeout: 10000 });
  const prefillYear = await editForm.locator('select').first().inputValue();
  const prefillName = await editForm.locator('input[type="text"]').first().inputValue();
  check(
    '编辑表单回填该条生辰（年份 + 姓名）',
    prefillYear === '1981' && prefillName === '管理甲',
    `year=${prefillYear} name=${prefillName}`,
  );
  await editForm.locator('input[type="text"]').first().fill('管理甲改');
  await editForm.locator('button[type="submit"]').click();
  await editForm.waitFor({ state: 'detached', timeout: 15000 });
  const afterEdit = await readServer();
  const editedRecord = afterEdit.payload?.history?.find((record) => record.info.year === 1981);
  check(
    '编辑保存后只替换这一条（不是新增）',
    editedRecord?.info?.name === '管理甲改' &&
      afterEdit.payload?.history?.length === 4 &&
      !afterEdit.payload?.history?.some((record) => record.info.name === '管理甲'),
    `name=${editedRecord?.info?.name ?? 'n/a'} history=${afterEdit.payload?.history?.length ?? 'n/a'}`,
  );

  // 编辑旧版没有表单快照的记录 C：提示按中点预填，直接保存不改时辰
  const legacyRow = rows.filter({ hasText: '1985-05-06' });
  await legacyRow.locator('[data-ziwei-manager-edit]').click();
  await manager.locator('[data-ziwei-manager-edit-form]').waitFor({ state: 'visible', timeout: 10000 });
  check(
    '没有表单快照的旧记录会提示「时间按中点预填」',
    await manager.locator('[data-ziwei-manager-derived-hint]').isVisible(),
  );
  await manager.locator('[data-ziwei-manager-edit-form] button[type="submit"]').click();
  await manager.locator('[data-ziwei-manager-edit-form]').waitFor({ state: 'detached', timeout: 15000 });
  const afterLegacyEdit = await readServer();
  const legacyRecord = afterLegacyEdit.payload?.history?.find((record) => record.info.year === 1985);
  check(
    '旧记录保存后时辰不变，并补上表单快照',
    legacyRecord?.info?.hour === 4 && Boolean(legacyRecord?.form?.clockHour),
    `hour=${legacyRecord?.info?.hour ?? 'n/a'} form=${JSON.stringify(legacyRecord?.form ?? null).slice(0, 80)}`,
  );

  // 删除历史记录 B：只少这一条，当前命盘不动
  const deleteRow = rows.filter({ hasText: '1972-08-09' });
  await deleteRow.locator('[data-ziwei-manager-delete]').click();
  await deleteRow.locator('[data-ziwei-manager-confirm-delete]').click();
  await deleteRow.waitFor({ state: 'detached', timeout: 15000 });
  const afterDelete = await readServer();
  check(
    '单条删除只删这一条（其它记录与当前命盘保留）',
    afterDelete.payload?.current?.info?.year === 1990 &&
      afterDelete.payload?.history?.length === 3 &&
      !afterDelete.payload?.history?.some((record) => record.info.year === 1972),
    `current=${afterDelete.payload?.current?.info?.year ?? 'n/a'} history=${afterDelete.payload?.history?.length ?? 'n/a'}`,
  );

  // 删除当前命盘的那条：current 清空，其它历史保留
  const liveRow = rows.filter({ hasText: '1990-06-15' });
  await liveRow.locator('[data-ziwei-manager-delete]').click();
  await liveRow.locator('[data-ziwei-manager-confirm-delete]').click();
  await liveRow.waitFor({ state: 'detached', timeout: 15000 });
  const afterDeleteCurrent = await readServer();
  check(
    '删除当前生辰后 current 清空、其它历史保留',
    afterDeleteCurrent.payload?.current === null &&
      afterDeleteCurrent.payload?.history?.length === 2 &&
      !afterDeleteCurrent.payload?.history?.some((record) => record.info.year === 1990),
    `current=${JSON.stringify(afterDeleteCurrent.payload?.current ?? null)} history=${afterDeleteCurrent.payload?.history?.length ?? 'n/a'}`,
  );

  // 把 1990 那条写回去（用起盘时保存的表单快照），继续验证「重新起盘回填」
  const rebuild = await context.request
    .post(birthEndpoint, {
      data: { info: afterSubmit.payload?.current?.info, form: afterSubmit.payload?.current?.form },
    })
    .catch(() => null);
  check('重新写回 1990 记录（继续恢复流程）', Boolean(rebuild && rebuild.ok()));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("重新起盘")', { timeout: 20000 });

  // 重新起盘：表单要回填
  await page.locator('button:has-text("重新起盘")').click();
  await page.waitForSelector('button[type="submit"]', { timeout: 20000 });
  const yearValue = await page.locator('select').first().inputValue();
  check('重新起盘后表单回填上次输入', yearValue === '1990', `year=${yearValue}`);
  check('表单页提示已回填 + 提供忘记入口', (await page.locator('text=忘记这个生辰').count()) > 0);
  await page.screenshot({ path: `${shotDir}/02-prefilled-form.png` });

  // 忘记：清空配置
  await page.locator('button:has-text("忘记这个生辰")').click();
  await page.waitForTimeout(800);
  const afterForget = await readServer();
  check(
    '点「忘记这个生辰」后当前记录被清空、历史仍保留',
    afterForget.payload?.current == null &&
      Array.isArray(afterForget.payload?.history) &&
      afterForget.payload.history.length >= 1,
    `current=${JSON.stringify(afterForget.payload?.current ?? null)} history=${afterForget.payload?.history?.length ?? 'n/a'}`,
  );
  await page.screenshot({ path: `${shotDir}/03-forgotten.png` });

  // 「忘记」只清 current；从表单页打开生辰管理，历史应该还在
  await page.locator('[data-ziwei-manage-form]').click();
  await manager.waitFor({ state: 'visible', timeout: 10000 });
  const rowsAfterForget = await rows.count();
  check(
    '「忘记」后从表单页仍能打开生辰管理（历史还在）',
    rowsAfterForget === 3,
    `rows=${rowsAfterForget}`,
  );
  await page.screenshot({ path: `${shotDir}/05-manager-after-forget.png` });
  await manager.locator('[data-ziwei-manager-close]').click();
  await manager.waitFor({ state: 'detached', timeout: 10000 });

  // ── 手机端：表单页 / 命盘页都不横向溢出，生辰管理弹层留在视口内 ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-ziwei-manage-form]', { timeout: 20000 });
  const mobileFormWidth = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  check(
    '手机端生辰表单页无横向溢出',
    mobileFormWidth.sw <= mobileFormWidth.cw + 1,
    `scrollWidth=${mobileFormWidth.sw} clientWidth=${mobileFormWidth.cw}`,
  );
  await page.locator('[data-ziwei-recent-item]').first().click();
  await page.waitForSelector('[data-ziwei-recent]', { timeout: 20000 });
  await page.waitForTimeout(800);
  const mobileChartWidth = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  check(
    '手机端命盘页无横向溢出',
    mobileChartWidth.sw <= mobileChartWidth.cw + 1,
    `scrollWidth=${mobileChartWidth.sw} clientWidth=${mobileChartWidth.cw}`,
  );
  await page.locator('[data-ziwei-recent]').click();
  await page.locator('[data-ziwei-manage]').click();
  await manager.waitFor({ state: 'visible', timeout: 10000 });
  const managerFitsMobile = await manager.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= -1 && box.right <= window.innerWidth + 1 && box.top >= -1;
  });
  check('手机端生辰管理弹层不超出视口', managerFitsMobile);
  await page.screenshot({ path: `${shotDir}/06-mobile.png` });
  await manager.locator('[data-ziwei-manager-close]').click();
  await manager.waitFor({ state: 'detached', timeout: 10000 });
  await page.setViewportSize({ width: 1280, height: 900 });

  // 完整还原用户原有记录（current + 历史列表）：先清空，再按旧→新回放历史，最后写回 current。
  // 只回写 current 会把「最近生辰」里的历史冲掉（曾经真的丢过）。
  await context.request.delete(`${birthEndpoint}?scope=all`).catch(() => null);
  const replay = Array.isArray(before?.history) ? [...before.history].reverse() : [];
  let restoreOk = true;
  for (const record of replay) {
    const res = await context.request
      .post(birthEndpoint, { data: { info: record.info, form: record.form } })
      .catch(() => null);
    if (!res || !res.ok()) restoreOk = false;
  }
  if (before?.current?.info) {
    const restored = await context.request
      .post(birthEndpoint, { data: { info: before.current.info, form: before.current.form } })
      .catch(() => null);
    if (!restored || !restored.ok()) restoreOk = false;
  }
  const afterRestore = await readServer();
  check(
    '验收后完整恢复了原有的生辰记录（含最近列表）',
    restoreOk &&
      (afterRestore.payload?.history?.length ?? 0) >= (before?.history?.length ?? 0) &&
      (afterRestore.payload?.current?.info?.year ?? null) === (before?.current?.info?.year ?? null),
    `history=${afterRestore.payload?.history?.length ?? 'n/a'} current=${afterRestore.payload?.current?.info?.year ?? null}`,
  );

  check('无页面 JS 报错', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} 通过`);
process.exit(passed === checks.length ? 0 : 1);

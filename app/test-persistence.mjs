// 生辰记忆（服务端配置文件）回归测试：
//   清空 → 起盘写配置 → 重载自动恢复 → 换一个浏览器上下文仍能恢复 → 重新起盘回填 → 忘记清空。
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

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
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

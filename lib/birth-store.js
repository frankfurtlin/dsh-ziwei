/**
 * 生辰的服务端存储。
 *
 * 用户在排盘页输入过的生辰写到 DSH 宿主的配置文件里（默认
 * `$DSH_HOME/ziwei/birth.json`，即 `~/.dsh/ziwei/birth.json`），
 * 不再用浏览器 localStorage。文件 0600，只有本机上的当前用户可读。
 *
 * 结构：
 * {
 *   "version": 1,
 *   "current": { "savedAt": "...", "info": {...}, "form": {...} },
 *   "history": [ { "savedAt": "...", "info": {...}, "form": {...} }, ... ]
 * }
 *
 * `current` 用于「下次打开自动恢复命盘」，`history` 保留最近若干次输入
 * （同一天同一个人反复起盘不会把文件撑大：完全相同的记录会被移到最前，
 * 不重复追加）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_HISTORY = 20
const FILE_VERSION = 1

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 配置文件路径；可用 DSH_ZIWEI_BIRTH_FILE 覆盖（测试用）。 */
export function birthFile() {
  return process.env.DSH_ZIWEI_BIRTH_FILE ?? join(dshHome(), 'ziwei', 'birth.json')
}

/** 公历日期是否真实存在（1990-2-31 能过范围校验，但排盘引擎会抛错）。 */
function isRealDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isBirthInfo(value) {
  if (!value || typeof value !== 'object') return false
  const info = value
  const num = (key) => Number.isInteger(info[key]) && Number.isFinite(info[key])
  if (!(num('year') && num('month') && num('day') && num('hour'))) return false
  if (info.gender !== 'male' && info.gender !== 'female') return false
  if (info.hour < 0 || info.hour > 11) return false
  return isRealDate(info.year, info.month, info.day)
}

/** 校验并规整一条记录；不合法返回 null。 */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null
  if (!isBirthInfo(value.info)) return null
  return {
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
    info: value.info,
    form: value.form && typeof value.form === 'object' ? value.form : undefined,
  }
}

function normalizeStore(value) {
  const store = { version: FILE_VERSION, current: null, history: [] }
  if (!value || typeof value !== 'object') return store
  const current = normalizeRecord(value.current)
  if (current) store.current = current
  if (Array.isArray(value.history)) {
    for (const item of value.history) {
      const record = normalizeRecord(item)
      if (record) store.history.push(record)
      if (store.history.length >= MAX_HISTORY) break
    }
  }
  return store
}

function identityKey(record) {
  const { year, month, day, hour, gender, name } = record.info
  return [year, month, day, hour, gender, name ?? ''].join('|')
}

/** 稳定 id：由生辰身份派生，不落盘。老数据不用迁移也能直接定位、编辑、删除。 */
function recordId(record) {
  const digest = createHash('sha1').update(identityKey(record)).digest('hex')
  return `b_${digest.slice(0, 16)}`
}

/** 对外返回的单条记录：补上 id；存储文件本身不写 id。 */
export function publicRecord(record) {
  if (!record) return null
  return { id: recordId(record), savedAt: record.savedAt, info: record.info, form: record.form }
}

/** 对外返回的整份存储：current 与 history 都带 id。 */
export function publicStore(store) {
  return {
    version: store.version,
    current: publicRecord(store.current),
    history: store.history.map((item) => publicRecord(item)),
  }
}

/** 读配置；文件不存在时当空存储（不让读失败挡住排盘）。 */
export async function readBirthStore() {
  const file = birthFile()
  try {
    const raw = await readFile(file, 'utf8')
    return normalizeStore(JSON.parse(raw))
  } catch (error) {
    // 文件被写坏时先留一份现场再当空存储：以前是静默丢掉 20 条历史，无法追查。
    if (error && error.code !== 'ENOENT') {
      const backup = `${file}.corrupt-${Date.now()}`
      try {
        await copyFile(file, backup)
        console.warn(`[dsh-ziwei] 生辰配置无法解析（${error.message}），已备份到 ${backup}`)
      } catch {}
    }
    return normalizeStore(null)
  }
}

/**
 * 写队列：读改写必须串行。
 *
 * 两个标签页同时保存时，各自「读旧文件→改→写」，后写的会把前一次的历史吞掉
 * （实测 8 个并发 POST 只剩 1 条）。
 */
let writeChain = Promise.resolve()
function serialize(task) {
  const run = writeChain.then(task, task)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function writeStore(store) {
  const file = birthFile()
  await mkdir(dirname(file), { recursive: true })
  // tmp 名必须唯一：以前只带 pid，同进程的两个并发写会互相覆盖同一个临时文件
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => {})
  return file
}

/** 记一条生辰：写进 current，并把同一个人同一天的记录去重后塞进 history 最前面。 */
export async function saveBirthRecord(info, form) {
  if (!isBirthInfo(info)) {
    const error = new Error('出生信息不完整（需要 year/month/day/hour/gender）')
    error.statusCode = 400
    throw error
  }
  return serialize(async () => {
    const store = await readBirthStore()
    const record = {
      savedAt: new Date().toISOString(),
      info,
      form: form && typeof form === 'object' ? form : undefined,
    }
    store.current = record
    const key = identityKey(record)
    store.history = [record, ...store.history.filter((item) => identityKey(item) !== key)].slice(
      0,
      MAX_HISTORY,
    )
    await writeStore(store)
    return record
  })
}

/** 单条编辑：按稳定 id 找到记录，用新信息替换；改出重复身份时只保留编辑后的这条。 */
export async function updateBirthRecord(id, info, form) {
  if (!isBirthInfo(info)) {
    const error = new Error('出生信息不完整（需要 year/month/day/hour/gender）')
    error.statusCode = 400
    throw error
  }
  if (typeof id !== 'string' || id === '') {
    const error = new Error('缺少记录 id')
    error.statusCode = 400
    throw error
  }
  return serialize(async () => {
    const store = await readBirthStore()
    const target = store.history.find((item) => recordId(item) === id)
    const isCurrent = Boolean(store.current && recordId(store.current) === id)
    const found = target ?? (isCurrent ? store.current : null)
    if (!found) {
      const error = new Error('找不到这条生辰记录')
      error.statusCode = 404
      throw error
    }
    const updated = {
      savedAt: found.savedAt || new Date().toISOString(),
      info,
      form: form && typeof form === 'object' ? form : undefined,
    }
    const key = identityKey(updated)
    const history = []
    let placed = false
    for (const item of store.history) {
      if (recordId(item) === id) {
        if (!placed) {
          history.push(updated)
          placed = true
        }
        continue
      }
      if (identityKey(item) === key) continue
      history.push(item)
    }
    if (!placed) history.unshift(updated)
    store.history = history.slice(0, MAX_HISTORY)
    if (isCurrent || (store.current && identityKey(store.current) === key)) {
      store.current = updated
    }
    await writeStore(store)
    return store
  })
}

/** 单条删除：从 history 移除；如果删的正是 current，current 一并清空。 */
export async function removeBirthRecord(id) {
  if (typeof id !== 'string' || id === '') {
    const error = new Error('缺少记录 id')
    error.statusCode = 400
    throw error
  }
  return serialize(async () => {
    const store = await readBirthStore()
    const inHistory = store.history.some((item) => recordId(item) === id)
    const isCurrent = Boolean(store.current && recordId(store.current) === id)
    if (!inHistory && !isCurrent) {
      const error = new Error('找不到这条生辰记录')
      error.statusCode = 404
      throw error
    }
    store.history = store.history.filter((item) => recordId(item) !== id)
    if (isCurrent) store.current = null
    await writeStore(store)
    return store
  })
}

/** 「忘记这个生辰」：只清掉 current（下次打开不再自动恢复），历史列表保留。
 *
 * 以前这里把 history 也一起删了，用户点一次「忘记」等于抹掉全部记录，
 * 和按钮文案不符，也丢数据。
 */
export async function clearCurrentBirth() {
  return serialize(async () => {
    const store = await readBirthStore()
    store.current = null
    await writeStore(store)
    return store
  })
}

/** 清空全部（current + history），只在用户显式选择「清空全部记录」时用。 */
export async function clearBirthStore() {
  return serialize(async () => {
    const store = { version: FILE_VERSION, current: null, history: [] }
    await writeStore(store)
    return store
  })
}

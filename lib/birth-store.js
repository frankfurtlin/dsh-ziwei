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

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

function isBirthInfo(value) {
  if (!value || typeof value !== 'object') return false
  const info = value
  const num = (key) => typeof info[key] === 'number' && Number.isFinite(info[key])
  return (
    num('year') &&
    num('month') &&
    num('day') &&
    num('hour') &&
    (info.gender === 'male' || info.gender === 'female') &&
    info.hour >= 0 &&
    info.hour <= 11
  )
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

/** 读配置；文件不存在或坏了都当空存储（不让读失败挡住排盘）。 */
export async function readBirthStore() {
  try {
    const raw = await readFile(birthFile(), 'utf8')
    return normalizeStore(JSON.parse(raw))
  } catch {
    return normalizeStore(null)
  }
}

async function writeStore(store) {
  const file = birthFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
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
}

/** 清空（「忘记这个生辰」）：current 与 history 一起删。 */
export async function clearBirthStore() {
  const store = { version: FILE_VERSION, current: null, history: [] }
  await writeStore(store)
  return store
}

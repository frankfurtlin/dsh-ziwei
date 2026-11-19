'use client';

/**
 * 记住上一次输入的出生信息 —— 服务端存储版。
 *
 * 数据由 DSH 插件 host 半（`plugins/dsh-ziwei/lib/birth-store.js`）写进宿主上的
 * 配置文件（默认 `~/.dsh/ziwei/birth.json`，0600），接口是同源的
 * `GET/POST/PATCH/DELETE /ziwei/birth`，所以：
 *   - 换浏览器、换设备、清缓存都不会丢；
 *   - 数据不出这台机器（不经过任何第三方）；
 *   - 整个接口在 DSH 的登录闸门后面，未登录拿不到。
 *
 * 每条记录带一个由生辰身份派生的稳定 `id`（host 端计算，不写进配置文件），
 * 「生辰管理」用它来编辑/删除某一条。
 *
 * 以前写过 localStorage（键 `ziwei-birth-v1`），首次加载会把那条旧记录清掉，
 * 避免同一份生辰在浏览器里留残影。
 */

import type { BirthInfo } from '@/lib/ziwei/types';

const ENDPOINT = '/ziwei/birth';
const LEGACY_STORAGE_KEY = 'ziwei-birth-v1';
const VERSION = 1;

export interface StoredBirth {
  version: number;
  /** host 端派生的稳定 id；旧版接口返回的记录没有这个字段 */
  id: string;
  savedAt: string;
  info: BirthInfo;
  /** BirthFormState 的快照；老数据可能没有 */
  form?: Record<string, unknown>;
}

interface BirthPayload {
  current?: unknown;
  history?: unknown;
}

/**
 * 公历日期是否真实存在。
 *
 * 只校验「1–31」是不够的：1990-2-31 能通过范围校验，但排盘引擎会抛
 * `RangeError: solar date does not exist`，恢复盘面时整页白屏。
 */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidInfo(value: unknown): value is BirthInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  const num = (key: string) => typeof info[key] === 'number' && Number.isFinite(info[key] as number);
  if (!(num('year') && num('month') && num('day') && num('hour'))) return false;
  if (info.gender !== 'male' && info.gender !== 'female') return false;
  const { year, month, day, hour } = info as { year: number; month: number; day: number; hour: number };
  if (!Number.isInteger(hour) || hour < 0 || hour > 11) return false;
  return isRealDate(year, month, day);
}

function normalize(record: unknown): StoredBirth | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  if (!isValidInfo(value.info)) return null;
  const form = value.form && typeof value.form === 'object' ? (value.form as Record<string, unknown>) : undefined;
  return {
    version: VERSION,
    id: typeof value.id === 'string' ? value.id : '',
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
    info: value.info,
    form,
  };
}

/** 清掉早期版本留在浏览器里的那一条（只执行一次，失败无所谓）。 */
function dropLegacyLocalRecord(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* 隐私模式：忽略 */
  }
}

/** 读整个生辰集合；接口不可用（比如脱离 DSH 直接跑 Next dev）时返回 null。 */
async function readBirthPayload(): Promise<BirthPayload | null> {
  dropLegacyLocalRecord();
  try {
    const response = await fetch(ENDPOINT, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    return (await response.json()) as BirthPayload;
  } catch {
    return null;
  }
}

/** 记录去重键：优先用 host 给的稳定 id，旧接口回退到身份字段。 */
function recordKey(record: StoredBirth): string {
  if (record.id) return record.id;
  const { year, month, day, hour, gender, name } = record.info;
  return `${year}-${month}-${day}-${hour}-${gender}-${name ?? ''}`;
}

/** 读服务端记下的生辰（current）；接口不可用时返回 null。 */
export async function loadSavedBirth(): Promise<StoredBirth | null> {
  const payload = await readBirthPayload();
  return normalize(payload?.current);
}

/** 读全部保存过的生辰：current 在前，其余按历史顺序（新的在前）。 */
export async function listAllBirths(): Promise<StoredBirth[]> {
  const payload = await readBirthPayload();
  if (!payload) return [];
  const seen = new Set<string>();
  const records: StoredBirth[] = [];
  for (const raw of [payload.current, ...(Array.isArray(payload.history) ? payload.history : [])]) {
    const record = normalize(raw);
    if (!record) continue;
    // current 与 history[0] 通常是同一条；同一个人同一天也只留一条
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return records;
}

/** 读最近用过的几个生辰（新的在前）；接口不可用时返回空数组。 */
export async function listRecentBirths(limit = 5): Promise<StoredBirth[]> {
  return (await listAllBirths()).slice(0, limit);
}

/** 记一条生辰（写配置文件，同时把刚存的记录返回给 UI 用）。 */
export async function saveBirth(
  info: BirthInfo,
  form?: Record<string, unknown>,
): Promise<StoredBirth | null> {
  const local: StoredBirth = { version: VERSION, id: '', savedAt: new Date().toISOString(), info, form };
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ info, form }),
      credentials: 'same-origin',
    });
    if (!response.ok) return local;
    const payload = (await response.json()) as { current?: unknown };
    return normalize(payload?.current) ?? local;
  } catch {
    // 存失败不影响这次排盘，只是下次不会自动恢复
    return local;
  }
}

/** 单条编辑：替换这条生辰的信息与表单快照，成功返回 true。 */
export async function updateBirth(
  id: string,
  info: BirthInfo,
  form?: Record<string, unknown>,
): Promise<boolean> {
  if (!id) return false;
  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ info, form }),
      credentials: 'same-origin',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 单条删除：删的如果是 current，服务端会一并清空自动恢复；成功返回 true。 */
export async function removeBirth(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 忘记这个生辰：只清 current（下次打开不再自动恢复），历史记录保留。 */
export async function clearSavedBirth(): Promise<boolean> {
  dropLegacyLocalRecord();
  try {
    const response = await fetch(ENDPOINT, { method: 'DELETE', credentials: 'same-origin' });
    return response.ok;
  } catch {
    return false;
  }
}

/** 清空全部记录（current + 历史），用户显式选择时才调用。 */
export async function clearAllBirths(): Promise<boolean> {
  dropLegacyLocalRecord();
  try {
    const response = await fetch(`${ENDPOINT}?scope=all`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    return response.ok;
  } catch {
    return false;
  }
}

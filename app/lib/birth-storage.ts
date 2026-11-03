'use client';

/**
 * 记住上一次输入的出生信息 —— 服务端存储版。
 *
 * 数据由 DSH 插件 host 半（`plugins/dsh-ziwei/lib/birth-store.js`）写进宿主上的
 * 配置文件（默认 `~/.dsh/ziwei/birth.json`，0600），接口是同源的
 * `GET/POST/DELETE /ziwei/birth`，所以：
 *   - 换浏览器、换设备、清缓存都不会丢；
 *   - 数据不出这台机器（不经过任何第三方）；
 *   - 整个接口在 DSH 的登录闸门后面，未登录拿不到。
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
  savedAt: string;
  info: BirthInfo;
  /** BirthFormState 的快照；老数据可能没有 */
  form?: Record<string, unknown>;
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

/** 读服务端记下的生辰；接口不可用（比如脱离 DSH 直接跑 Next dev）时返回 null。 */
export async function loadSavedBirth(): Promise<StoredBirth | null> {
  dropLegacyLocalRecord();
  try {
    const response = await fetch(ENDPOINT, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { current?: unknown };
    return normalize(payload?.current);
  } catch {
    return null;
  }
}

/** 读最近用过的几个生辰（新的在前，最多 5 条）；接口不可用时返回空数组。 */
export async function listRecentBirths(limit = 5): Promise<StoredBirth[]> {
  try {
    const response = await fetch(ENDPOINT, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { current?: unknown; history?: unknown };
    const seen = new Set<string>();
    const records: StoredBirth[] = [];
    for (const raw of [payload?.current, ...(Array.isArray(payload?.history) ? payload.history : [])]) {
      const record = normalize(raw);
      if (!record) continue;
      // 同一个人同一天只留一条（历史里可能因为重复起盘出现多次）
      const key = `${record.info.year}-${record.info.month}-${record.info.day}-${record.info.hour}-${record.info.gender}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  } catch {
    return [];
  }
}

/** 记一条生辰（写配置文件，同时把刚存的记录返回给 UI 用）。 */
export async function saveBirth(
  info: BirthInfo,
  form?: Record<string, unknown>,
): Promise<StoredBirth | null> {
  const local: StoredBirth = { version: VERSION, savedAt: new Date().toISOString(), info, form };
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

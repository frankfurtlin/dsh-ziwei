'use client';

import type { BirthFormState } from '@/components/BirthForm';
import type { StoredBirth } from '@/lib/birth-storage';

/** 时辰序号 → 中文时辰名。 */
export const HOUR_LABELS = [
  '子时', '丑时', '寅时', '卯时', '辰时', '巳时',
  '午时', '未时', '申时', '酉时', '戌时', '亥时',
];

/**
 * 一行一个生辰：「1990-06-15 23:30 · 子时 · 男 · 上海 · 张三」。
 *
 * 有表单快照时优先用它拼「几点几分 + 出生地」：同一天同一个人早晚子时会被
 * 换算成次日，只看 `info` 会看到日期跳了一天、也不知道是哪个城市校正出来的盘，
 * 列表里几条看起来一模一样，用户没法分辨。
 */
export function birthLabel(record: StoredBirth): string {
  const { info } = record;
  const form = (record.form ?? {}) as Partial<BirthFormState>;
  const date = `${info.year}-${String(info.month).padStart(2, '0')}-${String(info.day).padStart(2, '0')}`;
  const clock =
    form.clockHour !== undefined && form.clockHour !== ''
      ? ` ${String(form.clockHour).padStart(2, '0')}:${String(form.clockMinute ?? '0').padStart(2, '0')}`
      : '';
  const hour = HOUR_LABELS[info.hour] ?? `${info.hour} 时辰`;
  const gender = info.gender === 'female' ? '女' : '男';
  const city = form.city ? ` · ${form.city}` : '';
  return `${date}${clock} · ${hour} · ${gender}${city}${info.name ? ` · ${info.name}` : ''}`;
}

export interface BirthPrefill {
  initial: Partial<BirthFormState>;
  /** true 表示这条记录没有表单快照，时间是按「时辰中点」反推的 */
  derivedTime: boolean;
}

/**
 * 把一条已保存的生辰还原成 BirthForm 的初始值。
 *
 * 新记录都带 form 快照，直接回填；老记录（和 API 直接写入的记录）只有
 * `info`（年份 + 时辰序号），就按该时辰的中点 + 出生地经度反推钟点：
 * 这样用户点「保存」时算出来的时辰与原记录一致，不会因为编辑一下就把盘改错。
 */
export function toBirthPrefill(record: StoredBirth): BirthPrefill {
  const { info } = record;
  const form = (record.form ?? {}) as Partial<BirthFormState>;
  const hasClock = form.clockHour !== undefined && form.clockHour !== '';
  if (hasClock) {
    return {
      derivedTime: false,
      initial: {
        name: typeof form.name === 'string' ? form.name : (info.name ?? ''),
        year: String(form.year ?? info.year),
        month: String(form.month ?? info.month),
        day: String(form.day ?? info.day),
        clockHour: String(form.clockHour),
        clockMinute: String(form.clockMinute ?? '0'),
        unknownTime: Boolean(form.unknownTime),
        province: typeof form.province === 'string' ? form.province : (info.province ?? ''),
        city: typeof form.city === 'string' ? form.city : (info.city ?? ''),
        longitude: Number.isFinite(form.longitude) ? Number(form.longitude) : (info.longitude ?? 120),
        gender: form.gender === 'female' || form.gender === 'male' ? form.gender : info.gender,
      },
    };
  }
  const longitude = Number.isFinite(info.longitude) ? Number(info.longitude) : 120;
  // 时辰中点 → 钟点（用经度反推，保证表单再算一次真太阳时还是同一个时辰）
  const rawMinutes = info.hour === 0 ? 0 : 120 * info.hour - (longitude - 120) * 4;
  const minutes = ((Math.round(rawMinutes) % 1440) + 1440) % 1440;
  return {
    derivedTime: true,
    initial: {
      name: info.name ?? '',
      year: String(info.year),
      month: String(info.month),
      day: String(info.day),
      clockHour: String(Math.floor(minutes / 60)).padStart(2, '0'),
      clockMinute: String(minutes % 60).padStart(2, '0'),
      unknownTime: false,
      province: info.province ?? '',
      city: info.city ?? '',
      longitude,
      gender: info.gender,
    },
  };
}

/** 列表/菜单的稳定 key：优先用服务端 id，旧记录退化为出生信息。 */
export function recordKey(record: StoredBirth): string {
  if (record.id) return record.id;
  const info = record.info;
  return `${info.year}-${info.month}-${info.day}-${info.hour}-${info.gender}-${info.name ?? ''}`;
}

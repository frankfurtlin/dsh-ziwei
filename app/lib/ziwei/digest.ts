import { BRANCHES, SHICHEN, STEMS } from './constants';
import type { ZiweiChart } from './types';

/**
 * 把一张命盘压成纯文本摘要，供 DSH 插件把它交给 Agent 解读。
 *
 * 之所以放在 app 侧而不是插件侧：只有这里能拿到完整类型化的 ZiweiChart，
 * 插件拿到的是 postMessage 过来的字符串，避免两处重复实现星曜格式。
 */
export function digestChart(chart: ZiweiChart): string {
  const b = chart.birthInfo;
  const lunar = chart.lunarInfo;
  const shichen = SHICHEN[b.hour]?.name ?? '未知时辰';
  const place = [b.province, b.city].filter(Boolean).join(' ') || '未填';
  const lines: string[] = [];

  lines.push('【基本信息】');
  lines.push(
    `公历：${b.year}年${b.month}月${b.day}日 ${shichen}（${b.gender === 'male' ? '男' : '女'}），出生地：${place}`,
  );
  if (b.origInput) {
    const o = b.origInput;
    lines.push(
      `用户原始输入：${o.year}-${o.month}-${o.day} ${String(o.clockHour).padStart(2, '0')}:${String(o.clockMinute).padStart(2, '0')}（已按子时换日规则换算）`,
    );
  }
  lines.push(
    `农历：${STEMS[lunar.yearStem]}${BRANCHES[lunar.yearBranch]}年 ` +
      `${lunar.isLeapMonth ? '闰' : ''}${Math.abs(lunar.lunarMonth)}月${lunar.lunarDay}日`,
  );
  if (lunar.fourPillars) lines.push(`四柱（节气口径）：${lunar.fourPillars.join(' ')}`);
  if (lunar.fourPillarsLunar) lines.push(`四柱（农历口径）：${lunar.fourPillarsLunar.join(' ')}`);
  lines.push(`五行局：${chart.wuxingJuName}`);
  lines.push(
    `命宫：${BRANCHES[chart.mingGongBranch]}宫｜身宫：${BRANCHES[chart.shenGongBranch]}宫` +
      `${chart.mingZhu ? `｜命主：${chart.mingZhu}` : ''}${chart.shenZhu ? `｜身主：${chart.shenZhu}` : ''}` +
      `${chart.yinYangGender ? `｜${chart.yinYangGender}` : ''}`,
  );
  lines.push(`当前：${chart.currentAge} 岁，第 ${chart.currentDaXianIndex + 1} 大限`);
  lines.push('');

  lines.push('【十二宫（按地支顺序）】');
  for (const palace of chart.palaces) {
    const stars = palace.stars.map((star) => {
      const bits = [star.name];
      if (star.brightnessRaw) bits.push(star.brightnessRaw);
      if (star.siHua) bits.push(`化${star.siHua}`);
      return bits.join('');
    });
    const tags: string[] = [];
    if (palace.isMingGong) tags.push('命宫');
    if (palace.isShenGong) tags.push('身宫');
    if (palace.isCurrentDaXian) tags.push('当前大限');
    if (palace.daXianAge) tags.push(`大限${palace.daXianAge[0]}-${palace.daXianAge[1]}岁`);
    if (palace.selfSihua && palace.selfSihua.length > 0) {
      tags.push(`自化${palace.selfSihua.map((s) => `${s.starName}化${s.siHua}`).join('、')}`);
    }
    if (palace.isEmpty) tags.push(`空宫（借${palace.borrowedFromName ?? ''}）`);

    lines.push(
      `${palace.name}（${BRANCHES[palace.branch]}${STEMS[palace.stem]}）：` +
        `${stars.length > 0 ? stars.join(' ') : '（无星）'}` +
        `${tags.length > 0 ? `　［${tags.join('｜')}］` : ''}`,
    );
  }
  lines.push('');

  const bornSihua = chart.palaces
    .flatMap((palace) => palace.stars.map((star) => ({ palace, star })))
    .filter(({ star }) => star.siHua)
    .map(({ palace, star }) => `${star.name}化${star.siHua}在${palace.name}（${BRANCHES[palace.branch]}）`);
  if (bornSihua.length > 0) {
    lines.push('【生年四化】');
    lines.push(bornSihua.join('；'));
    lines.push('');
  }

  const daxian = chart.daXians[chart.currentDaXianIndex];
  if (daxian) {
    const sihua = daxian.siHua
      ? `；大限四化：${daxian.siHua.lu}禄/${daxian.siHua.quan}权/${daxian.siHua.ke}科/${daxian.siHua.ji}忌`
      : '';
    lines.push('【当前大限】');
    lines.push(
      `${daxian.startAge}-${daxian.endAge} 岁走${daxian.palaceName}（${BRANCHES[daxian.palaceBranch]}宫）` +
        `${daxian.stemName ? `，宫干${daxian.stemName}` : ''}${sihua}`,
    );
  }

  return lines.join('\n');
}

'use client';
import { motion } from 'framer-motion';
import type { Palace, Star } from '@/lib/ziwei/types';
import { STEMS, BRANCHES } from '@/lib/ziwei/constants';
import clsx from 'clsx';

interface PalaceCellProps {
  palace: Palace;
  onClick?: () => void;
  onStarClick?: (star: Star) => void;
  isSelected?: boolean;
  isSanFang?: boolean;
  delay?: number;
  /** 叠加四化：星名 → 四化类型（'禄'/'权'/'科'/'忌'） */
  overlayStarSiHua?: Record<string, string>;
  /** 叠加标签：'年'（流年）或 '限'（大限） */
  overlayLabel?: string;
  /** 点击叠加四化 badge 回调 */
  onSiHuaClick?: (starName: string, siHua: string) => void;
}

const SiHuaBadge = ({
  siHua,
  overlay,
  label,
  onClick,
}: {
  siHua: string;
  overlay?: boolean;
  label?: string;
  onClick?: (e: React.MouseEvent) => void;
}) => (
  <span
    className={clsx('palace-sihua', onClick && 'cursor-pointer')}
    data-sihua={siHua}
    data-overlay={overlay ? 'true' : 'false'}
    onClick={onClick}
  >
    {overlay && label && <span style={{ opacity: 0.7 }}>{label}</span>}
    {siHua}
  </span>
);

/**
 * 单个宫位
 *
 * 字阶只有三级：主星（17/600）→ 辅星（11）→ 宫名/干支/岁数（10.5–11）。
 * 语义色只用于四化与吉煞（四个色值），点选/大限用墨色描边与浅金底，
 * 不再用紫色/蓝色系统色。窄屏下辅星折叠成「+N」，把空间还给主星。
 */
export default function PalaceCell({
  palace, onClick, onStarClick, isSelected, isSanFang, delay = 0,
  overlayStarSiHua, overlayLabel, onSiHuaClick,
}: PalaceCellProps) {
  const { branch, stem, name, stars, daXianAge, isCurrentDaXian, isMingGong, isShenGong } = palace;
  const ganzhi = `${STEMS[stem]}${BRANCHES[branch]}`;

  const majorStars = stars.filter(s => s.type === 'major');
  const luckyStars = stars.filter(s => s.type === 'lucky');
  const shaStars = stars.filter(s => s.type === 'sha');
  const auxCount = luckyStars.length + shaStars.length;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay, ease: 'easeOut' }}
      role="button"
      tabIndex={0}
      aria-label={`${name}宫${isMingGong ? '，命宫' : ''}`}
      aria-pressed={Boolean(isSelected)}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={clsx(
        'palace-cell relative flex cursor-pointer flex-col transition-colors duration-150 h-full',
        isMingGong && 'is-ming',
        isCurrentDaXian && 'is-daxian',
        isSelected && 'is-selected',
        isSanFang && !isSelected && 'is-sanfang',
      )}
    >
      <div className="flex items-baseline justify-between gap-1">
        <div className="palace-cell-name flex min-w-0 items-center gap-1">
          <span className="palace-name">{name}</span>
          {isShenGong && <span className="palace-tag palace-tag-shen">身</span>}
        </div>
        {daXianAge && (
          <span className="palace-meta whitespace-nowrap">
            {daXianAge[0]}–{daXianAge[1]}
          </span>
        )}
      </div>

      <div className="palace-meta mt-0.5">{ganzhi}</div>

      {/* 主星：唯一的 17px 层级 */}
      <div className="mt-1 flex flex-1 flex-col gap-0.5">
        {majorStars.length === 0 && <span className="palace-empty">空宫</span>}
        {majorStars.map((star) => {
          const overlaySiHua = overlayStarSiHua?.[star.name];
          return (
            <div
              key={star.name}
              data-ziwei-star={star.name}
              className="flex items-center"
              onClick={event => { event.stopPropagation(); onStarClick?.(star); }}
            >
              <span className="palace-major" data-brightness={star.brightness}>
                {star.name}
              </span>
              {star.siHua && <SiHuaBadge siHua={star.siHua} />}
              {overlaySiHua && (
                <SiHuaBadge
                  siHua={overlaySiHua}
                  overlay
                  label={overlayLabel}
                  onClick={event => {
                    event.stopPropagation();
                    onSiHuaClick?.(star.name, overlaySiHua);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 辅星 / 煞星：窄屏折成 +N */}
      {auxCount > 0 && (
        <div className="palace-aux-lines mt-1 flex flex-wrap gap-x-1.5 gap-y-0.5">
          {luckyStars.map(s => {
            const overlaySiHua = overlayStarSiHua?.[s.name];
            return (
              <span key={s.name} className="palace-aux palace-lucky inline-flex items-center">
                {s.name}
                {s.siHua && <SiHuaBadge siHua={s.siHua} />}
                {overlaySiHua && (
                  <SiHuaBadge
                    siHua={overlaySiHua}
                    overlay
                    label={overlayLabel}
                    onClick={event => {
                      event.stopPropagation();
                      onSiHuaClick?.(s.name, overlaySiHua);
                    }}
                  />
                )}
              </span>
            );
          })}
          {shaStars.map(s => (
            <span key={s.name} className="palace-aux palace-sha inline-flex items-center">
              {s.name}
              {s.siHua && <SiHuaBadge siHua={s.siHua} />}
            </span>
          ))}
        </div>
      )}
      {auxCount > 0 && <span className="palace-aux-count">+{auxCount}</span>}
    </motion.div>
  );
}

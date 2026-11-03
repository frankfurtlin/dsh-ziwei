'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import BirthForm from '@/components/BirthForm';
import type { BirthFormState } from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import ChartSummary from '@/components/ChartSummary';
import InsightPanel from '@/components/InsightPanel';
import ShareModal from '@/components/ShareModal';
import StarDetailPanel from '@/components/StarDetailPanel';
import { generateChart } from '@/lib/ziwei/algorithm';
import { digestChart } from '@/lib/ziwei/digest';
import { detectPatterns, getMingGongSummary } from '@/lib/ziwei/patterns';
import { clearSavedBirth, loadSavedBirth, saveBirth } from '@/lib/birth-storage';
import type { StoredBirth } from '@/lib/birth-storage';
import type { BirthInfo, ZiweiChart, Palace, Star } from '@/lib/ziwei/types';

/**
 * 命盘页 —— 开源版「排盘引擎 Demo」
 *
 * 用本仓库的排盘引擎 generateChart() 渲染一张完整紫微命盘，并支持本命 / 大限 /
 * 流年切换、命盘总览（命格 · 四化 · 格局）、点星看解释、分享图。
 * 解读不在这里做：作为 DSH 插件嵌入时，盘面摘要会 postMessage 给宿主，
 * 由 DSH Agent 负责解读与追问（见 /root/workspace/plugins/dsh-ziwei）。
 *
 * 生辰记忆：写到宿主侧配置文件（插件 host 半的 /ziwei/birth 接口），换浏览器
 * 也能恢复；分享链接里的 `?b=YYYY-MM-DD-H&g=m` 优先于已存记录，打开分享链接
 * 不会覆盖本机记住的生辰。
 */

/** 把生辰压进分享链接：?b=1990-06-15-5&g=m&n=名字 */
function encodeShareBirth(info: BirthInfo): string {
  const params = new URLSearchParams();
  params.set('b', `${info.year}-${info.month}-${info.day}-${info.hour}`);
  params.set('g', info.gender === 'female' ? 'f' : 'm');
  if (info.name) params.set('n', info.name);
  return params.toString();
}

/** 解析分享链接里的生辰（不合法就当没有） */
function readSharedBirth(): BirthInfo | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('b');
  if (!raw) return null;
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 11) return null;
  const info: BirthInfo = { year, month, day, hour, gender: params.get('g') === 'f' ? 'female' : 'male' };
  const name = params.get('n');
  if (name) info.name = name;
  return info;
}

export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);
  const [saved, setSaved] = useState<StoredBirth | null>(null);
  // 本次页面里是不是用户刚手动起盘（决定解读面板要不要自动跑一次模型）
  const [submitted, setSubmitted] = useState(false);
  const [restored, setRestored] = useState(false);
  // 是不是从分享链接打开的（这种盘不读、也不写本机记住的生辰）
  const [shared, setShared] = useState(false);
  // 命盘概览抽屉：默认收起，把竖向空间留给盘面
  const [briefOpen, setBriefOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [starDetail, setStarDetail] = useState<{ star: Star; palaceName?: string } | null>(null);
  const formSnapshotRef = useRef<Record<string, unknown> | undefined>(undefined);

  // ── 宿主（DSH 插件面板）会量出宠物浮层的遮挡区域发过来 ──
  const [petInsets, setPetInsets] = useState({ bottom: 0, right: 0 });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; bottom?: number; right?: number } | null;
      if (!data || data.type !== 'dsh-ziwei:insets') return;
      const clamp = (value: unknown) => Math.max(0, Math.min(480, Number(value) || 0));
      setPetInsets({ bottom: clamp(data.bottom), right: clamp(data.right) });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── 挂载时优先用分享链接里的生辰，其次从服务端恢复上次生辰 ──
  useEffect(() => {
    const sharedBirth = readSharedBirth();
    if (sharedBirth) {
      setShared(true);
      setSubmitted(true);
      setChart(generateChart(sharedBirth));
      return;
    }
    let alive = true;
    void loadSavedBirth().then((stored) => {
      if (!alive || !stored) return;
      setSaved(stored);
      setChart(generateChart(stored.info));
      setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleSubmit = (info: BirthInfo) => {
    const form = formSnapshotRef.current;
    setSubmitted(true);
    setRestored(false);
    setSelectedPalace(null);
    setStarDetail(null);
    setChart(generateChart(info));
    // 写配置文件（失败不影响这次排盘，只是下次不自动恢复）
    void saveBirth(info, form).then((stored) => {
      if (stored) setSaved(stored);
    });
  };

  const handleForget = () => {
    setSaved(null);
    setRestored(false);
    void clearSavedBirth();
  };

  // ── 顶部概览条上的三个数字：命宫主星 / 五行局 / 格局数 ──
  const brief = useMemo(() => {
    if (!chart) return null;
    const summary = getMingGongSummary(chart);
    return { mingStars: summary.stars, keywords: summary.keywords, patterns: detectPatterns(chart) };
  }, [chart]);

  const shareUrl = useMemo(() => {
    if (!chart) return '';
    const query = encodeShareBirth(chart.birthInfo);
    if (typeof window === 'undefined') return `?${query}`;
    return `${window.location.origin}${window.location.pathname}?${query}`;
  }, [chart]);

  // ── DSH 插件桥接：把盘面摘要 postMessage 给父窗口（不嵌入时静默跳过）──
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    const payload = {
      type: 'dsh-ziwei:chart',
      summary: chart ? digestChart(chart) : '',
      birth: chart
        ? {
            name: chart.birthInfo.name ?? '',
            gender: chart.birthInfo.gender,
            year: chart.birthInfo.year,
            month: chart.birthInfo.month,
            day: chart.birthInfo.day,
            hour: chart.birthInfo.hour,
          }
        : null,
    };
    window.parent.postMessage(payload, window.location.origin);
  }, [chart]);

  // ── 未起盘：展示出生信息表单 ──
  if (!chart) {
    return (
      <main
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: '40px 20px 56px',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>紫微斗数排盘</h1>
        <p style={{ color: 'var(--t-text2)', marginBottom: 32, fontSize: 14, lineHeight: 1.7 }}>
          输入出生年月日时，开源排盘引擎即时生成命盘。
        </p>
        <BirthForm
          onSubmit={handleSubmit}
          initialData={saved?.form as Partial<BirthFormState> | undefined}
          onFormSave={(data) => {
            formSnapshotRef.current = data as unknown as Record<string, unknown>;
          }}
        />
        {saved && (
          <p style={{ marginTop: 20, fontSize: 12, color: 'var(--t-faint)' }}>
            表单已回填上次输入的生辰。生辰只存在本机配置文件中，{' '}
            <button
              type="button"
              onClick={handleForget}
              style={{
                border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--t-gold)', textDecoration: 'underline', font: 'inherit',
              }}
            >
              忘记这个生辰
            </button>
            。
          </p>
        )}
      </main>
    );
  }

  const toolbarButtonStyle: React.CSSProperties = {
    padding: '6px 14px',
    cursor: 'pointer',
    border: '1px solid var(--t-border)',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--t-text1)',
    font: 'inherit',
    whiteSpace: 'nowrap',
  };

  // ── 已起盘：命盘 ──
  return (
    <main
      data-pet-insets={`${petInsets.bottom},${petInsets.right}`}
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '14px 16px 12px',
        // 内嵌在 DSH 面板里时，整页吃掉 iframe 的可用高度，别在下面留一大片空白
        height: '100vh',
        minHeight: 640,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        <button
          type="button"
          data-ziwei-reset
          onClick={() => {
            setChart(null);
            setSelectedPalace(null);
            setStarDetail(null);
            setRestored(false);
            setShared(false);
          }}
          style={toolbarButtonStyle}
        >
          ← 重新起盘
        </button>
        <button type="button" data-ziwei-share data-ziwei-share-url={shareUrl} onClick={() => setShareOpen(true)} style={toolbarButtonStyle}>
          分享命盘
        </button>
        {shared && <span style={{ fontSize: 12, color: 'var(--t-faint)' }}>正在查看分享链接里的命盘</span>}
        {restored && saved && (
          <span style={{ fontSize: 12, color: 'var(--t-faint)' }}>
            已恢复上次记住的生辰
            {saved.savedAt ? `（${saved.savedAt.slice(0, 10)} 保存）` : ''}·{' '}
            <button
              type="button"
              onClick={handleForget}
              style={{
                border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--t-gold)', textDecoration: 'underline', font: 'inherit',
              }}
            >
              忘记
            </button>
          </span>
        )}
      </div>

      {/* 左侧排盘 + 命盘总览，右侧解读（解读走 DSH 模型的 /ziwei/ai，见 components/InsightPanel.tsx） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 420px)',
          gap: 18,
          marginTop: 8,
          flex: 1,
          minHeight: 0,
          alignItems: 'stretch',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, position: 'relative' }}>
          {/* 概览条：常驻一行（命宫主星 / 五行局 / 格局数），点开才展开完整总览 */}
          <div
            data-ziwei-brief
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '8px 12px',
              borderRadius: 10,
              flexShrink: 0,
              border: '1px solid var(--t-border)',
              background: 'var(--t-surface)',
              fontSize: 12,
              color: 'var(--t-text2)',
            }}
          >
            <span style={{ color: 'var(--t-gold)', fontWeight: 600 }}>
              命宫 · {brief?.mingStars.length ? brief.mingStars.join('') : '空宫'}
            </span>
            <span style={{ color: 'var(--t-faint)' }}>|</span>
            <span>{chart.wuxingJuName}</span>
            <span style={{ color: 'var(--t-faint)' }}>|</span>
            <span>格局 {brief?.patterns.length ?? 0} 个</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-ziwei-brief-toggle
              onClick={() => setBriefOpen((open) => !open)}
              style={{
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--t-gold)',
                font: 'inherit',
                textDecoration: 'underline',
              }}
            >
              {briefOpen ? '收起命盘概览' : '展开命盘概览'}
            </button>
          </div>

          {briefOpen && (
            <div data-ziwei-brief-body style={{ flexShrink: 0, maxHeight: '38vh', overflowY: 'auto', paddingRight: 4 }}>
              <ChartSummary chart={chart} />
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0 }}>
            <ChartBoard
              chart={chart}
              onPalaceSelect={setSelectedPalace}
              onStarSelect={(star, palace) => setStarDetail({ star, palaceName: palace.name })}
            />
          </div>

          {/* 点星看解释：浮在盘面右上角，不改变版面高度 */}
          {starDetail && (
            <div
              data-ziwei-star-detail
              style={{
                position: 'absolute',
                top: 48,
                right: 0,
                width: 360,
                maxWidth: '94%',
                zIndex: 30,
                background: 'var(--t-card)',
                border: '1px solid var(--t-border)',
                borderRadius: 14,
                boxShadow: '0 18px 48px rgba(13,13,11,0.16)',
                overflow: 'hidden',
              }}
            >
              <StarDetailPanel
                star={starDetail.star}
                palaceName={starDetail.palaceName}
                onClose={() => setStarDetail(null)}
              />
            </div>
          )}
        </div>

        <InsightPanel chart={chart} selectedPalace={selectedPalace} autoRun={submitted} petInsets={petInsets} />
      </div>

      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        shareUrl={shareUrl}
        chart={chart}
        birth={{
          year: String(chart.birthInfo.year),
          month: String(chart.birthInfo.month),
          day: String(chart.birthInfo.day),
          hour: String(chart.birthInfo.hour),
          minute: '0',
          gender: chart.birthInfo.gender,
          city: chart.birthInfo.city,
        }}
        highlight={brief?.mingStars.join('') || chart.wuxingJuName}
      />
    </main>
  );
}

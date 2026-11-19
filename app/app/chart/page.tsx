'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import BirthForm from '@/components/BirthForm';
import type { BirthFormState } from '@/components/BirthForm';
import BirthManager from '@/components/BirthManager';
import ChartBoard from '@/components/ChartBoard';
import ChartSummary from '@/components/ChartSummary';
import InsightPanel from '@/components/InsightPanel';
import ShareModal from '@/components/ShareModal';
import StarDetailPanel from '@/components/StarDetailPanel';
import { generateChart } from '@/lib/ziwei/algorithm';
import { digestChart } from '@/lib/ziwei/digest';
import { detectPatterns, getMingGongSummary } from '@/lib/ziwei/patterns';
import {
  clearAllBirths,
  clearSavedBirth,
  isRealDate,
  listAllBirths,
  loadSavedBirth,
  removeBirth,
  saveBirth,
  updateBirth,
} from '@/lib/birth-storage';
import { birthLabel, recordKey } from '@/lib/birth-label';
import { formToBirthInfo } from '@/lib/ziwei/share';
import type { StoredBirth } from '@/lib/birth-storage';
import type { BirthInfo, ZiweiChart, Palace, Star } from '@/lib/ziwei/types';

/**
 * 命盘页 —— 插件的主界面
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
  // 只校验范围不够：1990-2-31 能过范围校验，但排盘引擎会抛 RangeError → 整页白屏
  if (!isRealDate(year, month, day)) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 11) return null;
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
  // 服务端记着的全部生辰（列表、复用、「生辰管理」共用）
  const [records, setRecords] = useState<StoredBirth[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const birthMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // 「生辰管理」弹层：列出全部记录，支持单条起盘、编辑、删除
  const [managerOpen, setManagerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // 排盘失败时的可读提示（典型场景：分享链接/历史记录里的日期不存在）
  const [chartError, setChartError] = useState('');
  const formSnapshotRef = useRef<BirthFormState | undefined>(undefined);

  /** 排盘并兜住异常：非法日期不应该让整页白屏 */
  const safeChart = (info: BirthInfo): ZiweiChart | null => {
    if (!isRealDate(info.year, info.month, info.day)) {
      setChartError('这条生辰的公历日期不存在（例如 2 月 31 日），请重新填写。');
      return null;
    }
    try {
      const next = generateChart(info);
      setChartError('');
      return next;
    } catch (error) {
      setChartError(`排盘失败：${(error as Error)?.message || '日期不合法'}`);
      return null;
    }
  };

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
    if (!sharedBirth && new URLSearchParams(window.location.search).get('b')) {
      // 链接里的生辰日期不存在（如 2-31）：别整页白屏，回到手工输入并说明原因
      setChartError('链接里的生辰日期不合法（例如 2 月 31 日），已回到手工输入。');
    }
    if (sharedBirth) {
      setShared(true);
      setSubmitted(true);
      const next = safeChart(sharedBirth);
      if (next) setChart(next);
      else setShared(false);
      return;
    }
    let alive = true;
    void loadSavedBirth().then((stored) => {
      if (!alive || !stored) return;
      setSaved(stored);
      const next = safeChart(stored.info);
      if (next) {
        setChart(next);
        setRestored(true);
      } else {
        // 配置文件里是坏记录：别让它每次打开都失败
        void clearSavedBirth();
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // ── 全部保存过的生辰（存在宿主配置里，换浏览器也在）──
  const refreshRecords = () => {
    void listAllBirths().then(setRecords);
  };
  useEffect(() => {
    refreshRecords();
  }, []);

  const handleSubmit = (rawInfo: BirthInfo) => {
    const form = formSnapshotRef.current;
    // 23:00-23:59 是「晚子时」，按次日排盘；合盘页一直走 formToBirthInfo，
    // 排盘页以前直接吃 BirthForm 给的 day，两页会排出不同的盘 —— 这里统一。
    const info = form ? formToBirthInfo(form) : rawInfo;
    const next = safeChart(info);
    if (!next) return;
    setSubmitted(true);
    setRestored(false);
    setSelectedPalace(null);
    setStarDetail(null);
    setChart(next);
    // 写配置文件（失败不影响这次排盘，只是下次不自动恢复）
    void saveBirth(info, form as unknown as Record<string, unknown> | undefined).then((stored) => {
      if (stored) setSaved(stored);
      refreshRecords();
    });
  };

  /** 忘记这个生辰：只清「下次打开自动恢复」，最近记录保留（以前会把历史一起删掉）。 */
  const handleForget = () => {
    setSaved(null);
    setRestored(false);
    void clearSavedBirth().then(refreshRecords);
  };

  /** 清空全部生辰记录（连历史一起删，需要用户再确认一次）。 */
  const handleClearAll = () => {
    if (!window.confirm('清空全部生辰记录？包括「最近生辰」里的历史，删除后无法恢复。')) return;
    setSaved(null);
    setRestored(false);
    setRecords([]);
    setRecentOpen(false);
    setManagerOpen(false);
    void clearAllBirths();
  };

  // 两个下拉打开时：点外面或按 Esc 关闭
  useEffect(() => {
    if (!recentOpen && !moreOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (birthMenuRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return;
      setRecentOpen(false);
      setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRecentOpen(false);
      setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [recentOpen, moreOpen]);

  /** 打开「生辰管理」：先把列表拉新，避免弹层里是旧数据。 */
  const openManager = () => {
    setRecentOpen(false);
    setManagerOpen(true);
    refreshRecords();
  };

  /** 用一条已有生辰直接起盘（最近列表 / 生辰管理点选时用） */
  const applyStored = (record: StoredBirth) => {
    const next = safeChart(record.info);
    if (!next) return;
    setSubmitted(true);
    setRestored(false);
    setShared(false);
    setSelectedPalace(null);
    setStarDetail(null);
    setRecentOpen(false);
    setManagerOpen(false);
    setChart(next);
    void saveBirth(record.info, record.form).then((stored) => {
      if (stored) setSaved(stored);
      refreshRecords();
    });
  };

  /** 编辑一条历史生辰：PATCH 只改这一条；改的是当前命盘时同步刷新画布。 */
  const handleEditStored = async (
    record: StoredBirth,
    info: BirthInfo,
    form?: BirthFormState,
  ): Promise<boolean> => {
    const ok = await updateBirth(record.id, info, form as unknown as Record<string, unknown> | undefined);
    if (!ok) return false;
    if (!shared && saved?.id && saved.id === record.id) {
      const stored = await loadSavedBirth();
      if (stored) {
        setSaved(stored);
        setRestored(false);
        const next = safeChart(stored.info);
        if (next) setChart(next);
      }
    }
    refreshRecords();
    return true;
  };

  /** 删除一条生辰；删的正是当前命盘时只清「自动恢复」，盘面继续留着。 */
  const handleDeleteStored = async (record: StoredBirth): Promise<boolean> => {
    if (!record.id) return false;
    const ok = await removeBirth(record.id);
    if (!ok) return false;
    if (!shared && saved?.id === record.id) {
      setSaved(null);
      setRestored(false);
    }
    refreshRecords();
    return true;
  };

  /** 把当前盘面摘要复制到剪贴板，方便直接贴进 DSH 会话 */
  const handleCopyDigest = async () => {
    if (!chart) return;
    try {
      await navigator.clipboard.writeText(digestChart(chart));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 剪贴板不可用就静默失败，面板上的「让 DSH 解读」仍然可用 */
    }
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
      <main className="zw-form">
        <h1 style={{ fontFamily: 'var(--zw-serif)', fontSize: 26, fontWeight: 600, letterSpacing: '0.04em', marginBottom: 8 }}>
          紫微斗数排盘
        </h1>
        <p style={{ color: 'var(--t-text2)', marginBottom: 32, fontSize: 14, lineHeight: 1.7 }}>
          输入出生年月日时，本机排盘引擎即时生成命盘。
        </p>
        {chartError && (
          <p
            data-ziwei-error
            role="alert"
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid color-mix(in srgb, var(--zw-danger) 35%, transparent)',
              background: 'color-mix(in srgb, var(--zw-danger) 8%, transparent)',
              color: 'var(--zw-danger)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {chartError}
          </p>
        )}
        {records.length > 0 && (
          <div data-ziwei-recent-form style={{ marginTop: 0, marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--t-faint)' }}>最近用过：</span>
            {records.slice(0, 4).map((item) => (
              <button
                key={recordKey(item)}
                type="button"
                data-ziwei-recent-item
                onClick={() => applyStored(item)}
                style={{
                  padding: '5px 10px', cursor: 'pointer', fontSize: 12, font: 'inherit',
                  border: '1px solid var(--t-border)', borderRadius: 999, background: 'var(--t-surface)',
                  color: 'var(--t-text1)',
                }}
              >
                {birthLabel(item)}
              </button>
            ))}
          </div>
        )}
        {records.length > 0 && (
          <p style={{ margin: '0 0 16px', fontSize: 12 }}>
            <button
              type="button"
              data-ziwei-manage-form
              onClick={openManager}
              style={{
                border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--t-gold)', textDecoration: 'underline', font: 'inherit', fontSize: 12,
              }}
            >
              管理全部生辰（{records.length}）…
            </button>
          </p>
        )}
        <BirthForm
          onSubmit={handleSubmit}
          initialData={saved?.form as Partial<BirthFormState> | undefined}
          onFormSave={(data) => {
            formSnapshotRef.current = data as unknown as BirthFormState;
          }}
        />
        {saved && (
          <p style={{ marginTop: 20, fontSize: 12, color: 'var(--t-faint)' }}>
            表单已回填上次输入的生辰。生辰只存在本机配置文件中，{' '}
            <button
              type="button"
              data-ziwei-forget-form
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
        {managerOpen && (
          <BirthManager
            records={records}
            currentId={saved?.id}
            onClose={() => setManagerOpen(false)}
            onApply={applyStored}
            onEdit={handleEditStored}
            onDelete={handleDeleteStored}
            onClearAll={handleClearAll}
          />
        )}
      </main>
    );
  }

  // ── 已起盘：命盘 ──
  return (
    <main
      data-pet-insets={`${petInsets.bottom},${petInsets.right}`}
      className="zw-main"
    >
      <div className="zw-toolbar">
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
          className="zw-btn zw-btn-primary"
        >
          ← 重新起盘
        </button>
        <button
          type="button"
          data-ziwei-share
          data-ziwei-share-url={shareUrl}
          onClick={() => setShareOpen(true)}
          className="zw-btn"
        >
          分享命盘
        </button>
        {records.length > 0 && (
          <div className="zw-menu-anchor" ref={birthMenuRef}>
            <button
              type="button"
              data-ziwei-recent
              aria-expanded={recentOpen}
              onClick={() => {
                setMoreOpen(false);
                setRecentOpen((open) => !open);
              }}
              className="zw-btn"
            >
              生辰 <span aria-hidden style={{ opacity: 0.6 }}>{records.length}</span> ▾
            </button>
            {recentOpen && (
              <div data-ziwei-recent-list className="zw-menu" role="menu">
                {records.slice(0, 5).map((item) => (
                  <button
                    key={recordKey(item)}
                    type="button"
                    role="menuitem"
                    onClick={() => applyStored(item)}
                    className="zw-menu-item"
                    style={{ display: 'block' }}
                  >
                    {birthLabel(item)}
                  </button>
                ))}
                <div className="zw-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  data-ziwei-manage
                  onClick={() => {
                    setRecentOpen(false);
                    openManager();
                  }}
                  className="zw-menu-item zw-menu-item-muted"
                >
                  管理全部生辰…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-ziwei-clear-all
                  onClick={handleClearAll}
                  className="zw-menu-item zw-menu-item-danger"
                >
                  清空全部记录…
                </button>
              </div>
            )}
          </div>
        )}
        <span className="zw-toolbar-spacer" />
        <div className="zw-menu-anchor" ref={moreMenuRef}>
          <button
            type="button"
            data-ziwei-more
            aria-label="更多操作"
            aria-expanded={moreOpen}
            onClick={() => {
              setRecentOpen(false);
              setMoreOpen((open) => !open);
            }}
            className="zw-btn zw-btn-ghost"
          >
            ⋯
          </button>
          {moreOpen && (
            <div data-ziwei-more-list className="zw-menu zw-menu-right" role="menu">
              <button
                type="button"
                role="menuitem"
                data-ziwei-copy
                onClick={() => {
                  setMoreOpen(false);
                  void handleCopyDigest();
                }}
                className="zw-menu-item"
              >
                {copied ? '已复制摘要 ✓' : '复制盘面摘要'}
              </button>
              {saved && (
                <button
                  type="button"
                  role="menuitem"
                  data-ziwei-forget
                  onClick={() => {
                    setMoreOpen(false);
                    handleForget();
                  }}
                  className="zw-menu-item"
                >
                  忘记这个生辰
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 左侧排盘 + 命盘总览，右侧解读（解读走 DSH 模型的 /ziwei/ai，见 components/InsightPanel.tsx） */}
      <div className="zw-workspace">
        <div className="zw-chartcol">
          {/* 概览条：常驻一行（命宫主星 / 五行局 / 格局数），点开才展开完整总览 */}
          <div data-ziwei-brief className="zw-brief">
            <span className="zw-brief-strong">
              命宫 · {brief?.mingStars.length ? brief.mingStars.join('') : '空宫'}
            </span>
            <span className="zw-brief-sep">|</span>
            <span>{chart.wuxingJuName}</span>
            <span className="zw-brief-sep">|</span>
            <span>格局 {brief?.patterns.length ?? 0} 个</span>
            {shared && (
              <>
                <span className="zw-brief-sep">|</span>
                <span>正在查看分享链接里的命盘</span>
              </>
            )}
            {restored && saved && (
              <>
                <span className="zw-brief-sep">|</span>
                <span>
                  已恢复上次记住的生辰
                  {saved.savedAt ? `（${saved.savedAt.slice(0, 10)}）` : ''} ·{' '}
                  <button type="button" data-ziwei-forget onClick={handleForget} className="zw-link">
                    忘记
                  </button>
                </span>
              </>
            )}
            <span className="zw-toolbar-spacer" />
            <button
              type="button"
              data-ziwei-brief-toggle
              onClick={() => setBriefOpen((open) => !open)}
              className="zw-text-btn zw-brief-toggle"
              style={{ color: 'var(--zw-gold)' }}
            >
              {briefOpen ? '收起命盘概览' : '展开命盘概览'}
            </button>
          </div>

          {briefOpen && (
            <div data-ziwei-brief-body style={{ flexShrink: 0, maxHeight: '38vh', overflowY: 'auto', paddingRight: 4 }}>
              <ChartSummary chart={chart} />
            </div>
          )}

          <div className="zw-chart">
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

        <div className="zw-insight">
          <InsightPanel
            // 换一张盘就重建面板：否则旧盘的解读正文与追问历史会作为上下文继续发给模型
            key={chart ? digestChart(chart).slice(0, 24) + String(chart.birthInfo.year) + chart.birthInfo.hour : 'empty'}
            chart={chart}
            selectedPalace={selectedPalace}
            autoRun={submitted}
            petInsets={petInsets}
          />
        </div>
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

      {managerOpen && (
        <BirthManager
          records={records}
          currentId={saved?.id}
          onClose={() => setManagerOpen(false)}
          onApply={applyStored}
          onEdit={handleEditStored}
          onDelete={handleDeleteStored}
          onClearAll={handleClearAll}
        />
      )}
    </main>
  );
}

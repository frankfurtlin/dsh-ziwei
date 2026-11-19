'use client';

import { useEffect, useRef, useState } from 'react';
import BirthForm from '@/components/BirthForm';
import type { BirthFormState } from '@/components/BirthForm';
import { birthLabel, recordKey, toBirthPrefill } from '@/lib/birth-label';
import type { BirthPrefill } from '@/lib/birth-label';
import type { StoredBirth } from '@/lib/birth-storage';
import type { BirthInfo } from '@/lib/ziwei/types';
import { formToBirthInfo } from '@/lib/ziwei/share';

interface BirthManagerProps {
  /** 全部保存过的生辰（current 在前） */
  records: StoredBirth[];
  /** 当前命盘对应的记录 id，用于标「当前」 */
  currentId?: string;
  onClose: () => void;
  onApply: (record: StoredBirth) => void;
  onEdit: (record: StoredBirth, info: BirthInfo, form?: BirthFormState) => Promise<boolean>;
  onDelete: (record: StoredBirth) => Promise<boolean>;
  onClearAll: () => void;
}

interface EditState {
  record: StoredBirth;
  prefill: BirthPrefill;
}

/** 列表副行只说到「多久前」，精确时间交给 title，减少一行灰字的噪音 */
function savedAtText(value: string): string {
  if (!value) return '保存时间未知';
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return '保存时间未知';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚保存';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前保存`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前保存`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前保存`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} 保存`;
}

function savedAtExact(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function recordTitle(record: StoredBirth): string {
  return record.info.name?.trim() || '未命名';
}

/**
 * 生辰管理弹层：列出全部保存过的生辰，支持单条起盘、编辑、删除。
 *
 * 编辑复用 BirthForm（带原记录的表单快照回填）；没有快照的老记录按「时辰中点」
 * 预填钟点，保存时算出来的时辰与原来一致，避免一编辑就把盘改错。
 */
export default function BirthManager({
  records,
  currentId,
  onClose,
  onApply,
  onEdit,
  onDelete,
  onClearAll,
}: BirthManagerProps) {
  const [editing, setEditing] = useState<EditState | null>(null);
  const [pendingDelete, setPendingDelete] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draftRef = useRef<BirthFormState | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc 关闭 + Tab 焦点循环：弹层是模态的，键盘用户不应该被困住也逃不出去
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const beginEdit = (record: StoredBirth) => {
    draftRef.current = undefined;
    setError('');
    setPendingDelete('');
    setEditing({ record, prefill: toBirthPrefill(record) });
  };

  const submitEdit = async (rawInfo: BirthInfo) => {
    if (!editing) return;
    const form = draftRef.current;
    // 有完整表单快照时以表单为准（含晚子时换日、真太阳时换算）
    const info = form ? formToBirthInfo(form) : rawInfo;
    setBusy(true);
    setError('');
    const ok = await onEdit(editing.record, info, form);
    setBusy(false);
    if (!ok) {
      setError('保存失败，请稍后重试。');
      return;
    }
    setEditing(null);
  };

  const confirmDelete = async (record: StoredBirth) => {
    setBusy(true);
    setError('');
    const ok = await onDelete(record);
    setBusy(false);
    if (!ok) {
      setError('删除失败，请稍后重试。');
      return;
    }
    setPendingDelete('');
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? '编辑生辰' : '生辰管理'}
        data-ziwei-manager
        onClick={(event) => event.stopPropagation()}
        className="zw-manager"
        style={{ width: '100%', maxWidth: '660px', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div className="zw-manager-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="zw-manager-title">{editing ? '编辑生辰' : '生辰管理'}</div>
            <div className="zw-manager-sub">
              {editing ? '改完点「保存修改」；只改这一条，不动其它记录。' : `共 ${records.length} 条 · 可单条起盘、编辑或删除`}
            </div>
          </div>
          <button
            type="button"
            data-ziwei-manager-close
            aria-label="关闭"
            onClick={onClose}
            className="zw-btn zw-btn-ghost"
            style={{ height: '28px', padding: '0 9px', fontSize: '14px' }}
          >
            ×
          </button>
        </div>

        {error && (
          <div role="alert" style={{ padding: '10px 20px', fontSize: '12px', color: 'var(--zw-danger)' }}>
            {error}
          </div>
        )}

        {editing ? (
          <div data-ziwei-manager-edit-form style={{ padding: '14px 20px 22px' }}>
            <button
              type="button"
              data-ziwei-manager-back
              onClick={() => {
                setEditing(null);
                setError('');
              }}
              className="zw-text-btn"
              style={{ marginBottom: '12px' }}
            >
              ← 返回列表
            </button>
            <div style={{ marginBottom: '12px', fontSize: '12px', color: 'var(--zw-ink-3)' }}>
              {birthLabel(editing.record)}
            </div>
            {editing.prefill.derivedTime && (
              <div
                data-ziwei-manager-derived-hint
                style={{
                  marginBottom: '14px',
                  padding: '9px 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--zw-gold-line)',
                  background: 'var(--zw-gold-bg)',
                  fontSize: '11.5px',
                  lineHeight: 1.6,
                  color: 'var(--zw-ink-3)',
                }}
              >
                这条记录是旧版保存的，没有钟点快照：时间已按「该时辰的中点」预填。
                不改时辰直接保存，盘面不会变。
              </div>
            )}
            <BirthForm
              key={recordKey(editing.record)}
              initialData={editing.prefill.initial}
              onSubmit={submitEdit}
              onFormSave={(data) => {
                draftRef.current = data;
              }}
              loading={busy}
              submitLabel="保存修改"
            />
          </div>
        ) : (
          <div style={{ padding: '4px 20px 16px' }}>
            {records.length === 0 ? (
              <div style={{ padding: '26px 0', textAlign: 'center', fontSize: '12px', color: 'var(--zw-ink-3)' }}>
                还没有保存过生辰。
              </div>
            ) : (
              records.map((record) => {
                const isCurrent = Boolean(record.id) && record.id === currentId;
                return (
                  <div
                    key={recordKey(record)}
                    data-ziwei-manager-item
                    data-id={record.id}
                    className="zw-row"
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="zw-row-name">
                        {recordTitle(record)}
                        {isCurrent && <span className="zw-badge-current">当前</span>}
                      </div>
                      <div className="zw-row-birth">{birthLabel(record)}</div>
                      <div className="zw-row-time" title={savedAtExact(record.savedAt)}>
                        {savedAtText(record.savedAt)}
                      </div>
                    </div>
                    {record.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {pendingDelete === record.id ? (
                          <>
                            <button
                              type="button"
                              data-ziwei-manager-confirm-delete
                              disabled={busy}
                              onClick={() => void confirmDelete(record)}
                              className="zw-text-btn zw-text-btn-danger"
                            >
                              确认删除
                            </button>
                            <button
                              type="button"
                              data-ziwei-manager-cancel-delete
                              disabled={busy}
                              onClick={() => setPendingDelete('')}
                              className="zw-text-btn"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              data-ziwei-manager-apply
                              onClick={() => onApply(record)}
                              className="zw-text-btn"
                              style={{ color: 'var(--zw-gold)' }}
                            >
                              起盘
                            </button>
                            <button
                              type="button"
                              data-ziwei-manager-edit
                              disabled={busy}
                              onClick={() => beginEdit(record)}
                              className="zw-text-btn"
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              data-ziwei-manager-delete
                              disabled={busy}
                              onClick={() => {
                                setError('');
                                setPendingDelete(record.id);
                              }}
                              className="zw-text-btn zw-text-btn-danger"
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: '10.5px', color: 'var(--zw-ink-3)', textAlign: 'right' }}>
                        旧版接口暂不支持
                        <br />
                        单条管理
                      </div>
                    )}
                  </div>
                );
              })
            )}

            <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <button
                type="button"
                data-ziwei-manager-clear-all
                onClick={() => {
                  setError('');
                  setPendingDelete('');
                  onClearAll();
                }}
                className="zw-text-btn zw-text-btn-danger"
              >
                清空全部记录…
              </button>
              <span style={{ fontSize: '10.5px', color: 'var(--zw-ink-3)' }}>删除后无法恢复</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

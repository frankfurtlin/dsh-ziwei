'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import { digestChart } from '@/lib/ziwei/digest';

/**
 * 命理解读面板
 *
 * 这里**不再调用应用自带的 /api/interpret**（那个接口已经删掉）。作为 DSH 插件
 * 内嵌时，面板把命盘摘要 POST 到 `/ziwei/ai`，由 dsh-ziwei 插件的 host 半用 DSH
 * 自己选中的模型流式生成解读；脱离 DSH 单独打开时该接口不存在，面板会明确提示。
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface InsightPanelProps {
  chart: ZiweiChart;
  selectedPalace?: Palace | null;
  /** 进页自动生成「命格总览」；恢复上次生辰直接看盘时传 false，省一次模型调用 */
  autoRun?: boolean;
  /** 宿主层宠物浮层在右下角遮挡的区域（px），用来把输入区让开 */
  petInsets?: { bottom: number; right: number };
}

const TOPICS = [
  { key: 'overview', label: '命格' },
  { key: 'love', label: '感情' },
  { key: 'career', label: '事业' },
  { key: 'wealth', label: '财运' },
  { key: 'health', label: '健康' },
  { key: 'personality', label: '性格' },
] as const;

type TopicKey = (typeof TOPICS)[number]['key'];

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** SSE 一行一行的读，回调每段增量文本。 */
async function streamInterpret(
  payload: { topic?: string; digest: string; question?: string; history?: ChatMessage[]; thread: string },
  onDelta: (text: string) => void,
  signal: AbortSignal,
  onReasoning?: (chars: number) => void,
) {
  const res = await fetch(`${BASE_PATH}/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ziwei-thread': payload.thread },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `解读服务返回 ${res.status}`);
  }
  if (!res.body) throw new Error('解读服务没有返回内容流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let errorMessage = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      if (!raw.startsWith('data:')) continue;
      let event: { type?: string; text?: string; message?: string; chars?: number };
      try {
        event = JSON.parse(raw.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === 'delta' && event.text) onDelta(event.text);
      else if (event.type === 'reasoning') onReasoning?.(event.chars || 0);
      else if (event.type === 'error') errorMessage = event.message || '解读失败';
    }
  }

  if (errorMessage) throw new Error(errorMessage);
}

/** 极简富文本渲染：`【小节】` 当小标题，`**强调**` 加粗，其余按段落。 */
function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} style={{ height: 8 }} />;
        const isHeading = /^【.+】$/.test(trimmed);
        const nodes = trimmed.split(/(\*\*[^*]+\*\*)/g).map((piece, i) =>
          piece.startsWith('**') && piece.endsWith('**') ? (
            <strong key={i} style={{ fontWeight: 600, color: 'var(--t-text)' }}>
              {piece.slice(2, -2)}
            </strong>
          ) : (
            <span key={i}>{piece}</span>
          ),
        );
        return (
          <p
            key={index}
            style={{
              margin: isHeading ? '12px 0 4px' : '0 0 6px',
              fontSize: isHeading ? 13 : 13,
              fontWeight: isHeading ? 600 : 400,
              lineHeight: 1.75,
              color: isHeading ? 'var(--t-gold)' : 'var(--t-text2)',
              letterSpacing: isHeading ? '0.04em' : 0,
            }}
          >
            {nodes}
          </p>
        );
      })}
    </>
  );
}

export default function InsightPanel({
  chart,
  selectedPalace,
  autoRun = true,
  petInsets = { bottom: 0, right: 0 },
}: InsightPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // 模型在 deepseek-v4.1 上会先思考再出正文，给用户一个「还在动」的反馈
  const [reasoningChars, setReasoningChars] = useState(0);
  const [error, setError] = useState('');
  const [topic, setTopic] = useState<TopicKey>('overview');

  const messagesRef = useRef<ChatMessage[]>([]);
  const loadingRef = useRef(false);
  const startedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 一次页面会话一个 thread id：同一张盘上的追问复用同一个 provider 会话
  const threadRef = useRef<string>(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ziwei-${Math.random().toString(36).slice(2)}`,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const run = useCallback(
    async (question: string, nextTopic: TopicKey) => {
      if (loadingRef.current) return;
      setError('');
      setReasoningChars(0);
      setLoading(true);
      loadingRef.current = true;

      const history = messagesRef.current;
      const userBubble = question || `请解读：${TOPICS.find((item) => item.key === nextTopic)?.label ?? ''}`;
      setMessages([...history, { role: 'user', content: userBubble }, { role: 'assistant', content: '' }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamInterpret(
          {
            topic: nextTopic,
            digest: digestChart(chart),
            question,
            history: history.filter((item) => item.content.trim()),
            thread: threadRef.current,
          },
          (delta) => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { role: 'assistant', content: last.content + delta };
              }
              return next;
            });
          },
          controller.signal,
          setReasoningChars,
        );
      } catch (caught) {
        const message = String((caught as Error)?.message || caught);
        const friendly = /Failed to fetch|NetworkError|500/.test(message)
          ? '解读服务没接通：这里是 DSH 插件的内嵌页面才有 AI 能力，单独打开（127.0.0.1:8815）时没有该接口。'
          : message;
        setError(friendly);
        setMessages((prev) => prev.filter((item, index) => index !== prev.length - 1 || item.content));
      } finally {
        abortRef.current = null;
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [chart],
  );

  // 进页自动出一次「命格总览」（恢复上次盘面时不自动跑，见 autoRun）
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!autoRun) return;
    void run('', 'overview');
  }, [run, autoRun]);

  const askPalace = () => {
    if (!selectedPalace) return;
    const stars = selectedPalace.stars.map((star) => star.name).join('、') || '空宫';
    void run(`请重点分析【${selectedPalace.name}】（${stars}）这一宫，讲清它对命主意味着什么。`, topic);
  };

  const submit = () => {
    const question = input.trim();
    if (!question || loading) return;
    setInput('');
    void run(question, topic);
  };

  return (
    <aside
      style={{
        border: '1px solid var(--t-border)',
        borderRadius: 12,
        background: 'var(--t-card)',
        display: 'flex',
        flexDirection: 'column',
        // 撑满整列高度；底部留出 dsh-pet 的悬浮位（约 104px 见方），
        // 否则「追问」按钮会被宠物挡住点不到。
        height: '100%',
        minHeight: 0,
        marginBottom: 0,
        overflow: 'hidden',
        boxShadow: 'var(--board-shadow, 0 1px 3px rgba(0,0,0,0.06))',
      }}
    >
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--t-border)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '0.06em' }}>
            命理解读
          </span>
          <span style={{ fontSize: 11, color: 'var(--t-faint)' }}>由 DSH 模型生成</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {TOPICS.map((item) => {
            const active = item.key === topic;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setTopic(item.key);
                  void run('', item.key);
                }}
                disabled={loading}
                style={{
                  padding: '4px 11px',
                  fontSize: 12,
                  borderRadius: 999,
                  cursor: loading ? 'wait' : 'pointer',
                  border: `1px solid ${active ? 'var(--t-border-acc)' : 'var(--t-border)'}`,
                  background: active ? 'var(--t-surface)' : 'transparent',
                  color: active ? 'var(--t-gold)' : 'var(--t-text2)',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {selectedPalace && (
          <button
            type="button"
            onClick={askPalace}
            disabled={loading}
            style={{
              marginTop: 8,
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 6,
              cursor: loading ? 'wait' : 'pointer',
              border: '1px dashed var(--t-border-acc)',
              background: 'transparent',
              color: 'var(--t-gold)',
            }}
          >
            + 分析选中的「{selectedPalace.name}」
          </button>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        {messages.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--t-faint)', lineHeight: 1.7 }}>
            {loading
              ? reasoningChars > 0
                ? `模型正在思考这张盘…（已思考 ${reasoningChars} 字）`
                : '正在按这张盘生成解读…'
              : '已恢复上次生辰的命盘。点上面的标签，或选中某一宫再分析，即可用 DSH 的模型解读。'}
          </p>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} style={{ margin: '0 0 10px', textAlign: 'right' }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '6px 10px',
                  borderRadius: 8,
                  background: 'var(--t-surface)',
                  border: '1px solid var(--t-border)',
                  fontSize: 12,
                  color: 'var(--t-text1)',
                  lineHeight: 1.6,
                  maxWidth: '90%',
                  textAlign: 'left',
                }}
              >
                {message.content}
              </span>
            </div>
          ) : (
            <div key={index} style={{ marginBottom: 14 }}>
              {message.content ? (
                <RichText text={message.content} />
              ) : (
                <span style={{ fontSize: 12, color: 'var(--t-faint)' }}>解读中…</span>
              )}
            </div>
          ),
        )}
        {error && (
          <p style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, color: '#A83228' }}>{error}</p>
        )}
      </div>

      {/* 右下角是 dsh-pet 的固定浮层（宿主层，盖在 iframe 之上）。
          插件会量出它遮挡的区域发过来，这里把输入区让开，否则「追问」按钮点不到。 */}
      <div
        style={{
          padding: '10px 12px',
          paddingBottom: 12 + petInsets.bottom,
          paddingRight: 12 + petInsets.right,
          borderTop: '1px solid var(--t-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
            }}
            placeholder="继续追问，如：今年适合换工作吗？"
            disabled={loading}
            style={{
              flex: 1,
              padding: '8px 10px',
              fontSize: 12,
              borderRadius: 8,
              border: '1px solid var(--t-border)',
              background: 'var(--t-surface)',
              color: 'var(--t-text)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading || !input.trim()}
            style={{
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 8,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              minWidth: 56,
              border: '1px solid var(--t-border-acc)',
              background: loading || !input.trim() ? 'transparent' : 'rgba(184,146,42,0.10)',
              color: loading || !input.trim() ? 'var(--t-faint)' : 'var(--t-gold)',
              cursor: loading || !input.trim() ? 'default' : 'pointer',
            }}
          >
            {loading ? '解读中' : '追问'}
          </button>
        </div>
      </div>
    </aside>
  );
}

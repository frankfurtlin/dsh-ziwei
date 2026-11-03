/**
 * dsh-ziwei —— host 半的 AI 接口：`POST /ziwei/ai`
 *
 * 排盘应用自带的 `/api/interpret` 已经删掉，解读改由 DSH 自己的模型能力提供，
 * 所以这里不再是"再配一份 API Key"，而是直接取宿主当前选中的模型：
 *   provider/model ← ctx.agentDefaultModel.currentSelection()
 *   token 流        ← ctx.llm.stream()
 *
 * 请求体（JSON）：
 *   { topic?: string, digest: string, digestB?: string, question?: string, history?: [{role,content}] }
 *   topic = 'heming' 时用 digest（甲方）与 digestB（乙方）做合盘分析。
 * 响应：SSE，每条 `data: {"type":"delta"|"error"|"done", ...}\n\n`
 *
 * 这条路由挂在 /ziwei 前缀下，因此和反代一样先过 DSH 的登录闸门（调用方在
 * index.js 里已经调过 requestRejection），公网无从访问。
 */

import { randomUUID } from 'node:crypto'

const MAX_DIGEST_CHARS = 16000
const MAX_QUESTION_CHARS = 2000
const MAX_HISTORY_TURNS = 8
// 模型的思考（reasoning）也吃输出预算：预算给小了会出现「只想不说」，
// 一个字正文都没有。这里第一次给一个正常预算，若仍然没落地就放大预算重试一次。
const MAX_OUTPUT_TOKENS = 2600
const RETRY_OUTPUT_TOKENS = 6000
const RETRY_HINT =
  '\n\n（重要：请直接输出最终解读正文，不要在内部推演里反复权衡；正文控制在 700 字以内。）'
const CALL_TIMEOUT_MS = 180000

/** 命理顾问人格 + 输出纪律：先说结论，再讲依据，术语随用随解释。 */
const SYSTEM_PROMPT = `你是一位紫微斗数命理顾问，走三合派，参考倪海厦（倪师）体系解释星曜与格局。

回答纪律：
1. 先给结论（一两句话讲清这盘在这个主题上的基本盘），再展开依据。
2. 依据要落到具体的星、宫、四化上（例如「命宫在丑，紫微天相同宫」），不要空泛。
3. 术语第一次出现时用括号解释（例如「自化（这宫的宫干让星曜化出去，代表该领域易流失）」）。
4. 语言通俗、口语化，避免古文腔和宿命论；给建议时具体到「可以怎么做」。
5. 不超过 700 字；用「【小节】」分段，不要用 markdown 表格。
6. 命理只作参考，涉及健康/重大决策时提醒现实中的专业意见。`

/** 六个主题的提问模板，对应应用右侧那排 tab。 */
const TOPIC_PROMPTS = {
  overview: `请解读这张命盘的**命格总览**。按这几节写：【命格定性】【主星与格局】【三方四正】【当前大限】【优势与注意】。`,
  love: `请解读这张命盘的**感情婚姻**。按这几节写：【感情格局】【夫妻宫与四化】【三方联动】【当前大限感情运】【相处建议】。`,
  career: `请解读这张命盘的**事业**。按这几节写：【事业定性：宜任职还是宜创业】【官禄宫与四化】【财帛与事业的联动】【当前大限事业运】【具体建议】。`,
  wealth: `请解读这张命盘的**财运**。按这几节写：【财运定性：进财方式】【财帛宫与田宅宫】【四化落在哪】【风险点】【理财建议】。`,
  health: `请解读这张命盘的**健康倾向**。按这几节写：【体质与疾厄宫】【容易出问题的部位】【当前大限注意】【生活习惯建议】。`,
  personality: `请解读这张命盘的**性格**。按这几节写：【命宫主星塑造的性格底色】【身宫与外在表现】【容易卡住的地方】【如何发挥优势】。`,
}

function sendJson(res, status, payload, extraHeaders = null) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  })
  res.end(JSON.stringify(payload))
}

/** 读请求体（限长，避免大 body 打爆内存）。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    // 注意：超限时不要 `req.destroy()` —— 那样客户端只会看到连接重置（curl 报 000），
    // 拿不到 413 的说明。这里先 pause 住请求，让 handler 把 413 发出去再断开。
    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        req.pause()
      } catch {}
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error(`请求体超过 ${Math.round(limit / 1024)} KiB`), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => fail(error))
  })
}

function sanitize(text, max) {
  return typeof text === 'string' ? text.slice(0, max) : ''
}

/** 组装一条模型调用所需的 messages。 */
function buildMessages({ digest, digestB, topic, question, history, source }) {
  const parts = []
  const topicPrompt = TOPIC_PROMPTS[topic] || TOPIC_PROMPTS.overview
  parts.push(topicPrompt)
  if (topic === 'heming' && digestB) {
    parts.push(`【甲方命盘】\n${digest}`)
    parts.push(`【乙方命盘】\n${digestB}`)
  } else {
    parts.push(`【命盘】\n${digest}`)
  }
  if (question) parts.push(`【我的问题】\n${question}`)
  parts.push('请按上面的要求直接给出解读，不要复述命盘，不要客套开场。')

  const messages = []
  if (Array.isArray(history)) {
    for (const item of history.slice(-MAX_HISTORY_TURNS)) {
      if (!item || typeof item.content !== 'string' || !item.content.trim()) continue
      const text = item.content.slice(0, MAX_QUESTION_CHARS * 2)
      if (item.role === 'assistant') {
        // 历史里的 assistant 消息必须带 source，否则 pi-ai 适配器在
        // toPiAssistant() 里读 message.source.replayState 直接抛 TypeError。
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: source.provider, model: source.model },
        })
      } else {
        messages.push({ role: 'user', content: [{ type: 'text', text }] })
      }
    }
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] })
  return messages
}

/**
 * 处理一次 /ziwei/ai 调用。调用方负责先过登录闸门。
 * @param ctx cordis 上下文（需要 llm / agentDefaultModel 服务）
 */
export async function handleAiRequest(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只接受 POST' })
    return
  }

  const llm = ctx.get('llm', false)
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(res, 503, { error: 'DSH 的模型服务没有就绪（ctx.llm 不可用）。' })
    return
  }

  let selection
  try {
    const defaults = ctx.get('agentDefaultModel', false)
    selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
  } catch {
    selection = undefined
  }
  if (!selection || !selection.provider || !selection.model) {
    sendJson(res, 503, {
      error: '还没有选中模型：请在 DSH 的「设置 → 模型」里选一个默认模型，再回来解读。',
    })
    return
  }

  let body
  let rawBody
  try {
    rawBody = await readBody(req)
  } catch (error) {
    if (error && error.statusCode === 413) {
      // 请求体还没读完，先回 413 再断开，否则客户端只看到连接重置
      sendJson(res, 413, { error: error.message }, { connection: 'close' })
      res.on('finish', () => {
        try {
          req.destroy()
        } catch {}
      })
      return
    }
    sendJson(res, 400, { error: '读取请求体失败' })
    return
  }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' })
    return
  }

  const digest = sanitize(body.digest, MAX_DIGEST_CHARS)
  if (!digest.trim()) {
    sendJson(res, 400, { error: '缺少命盘摘要（digest）' })
    return
  }
  const digestB = sanitize(body.digestB, MAX_DIGEST_CHARS)

  const messages = buildMessages({
    digest,
    digestB,
    topic: typeof body.topic === 'string' ? body.topic : 'overview',
    question: sanitize(body.question, MAX_QUESTION_CHARS).trim(),
    history: body.history,
    source: { provider: selection.provider, model: selection.model },
  })

  // opencode 这类路由要求 x-opencode-session，否则 400 MissingSessionID；
  // 让内嵌页带一个稳定的 thread id 过来，同一页面里的追问复用同一会话。
  const threadHeader = String(req.headers['x-ziwei-thread'] || '')
  const sessionId = /^[\w.:-]{8,128}$/.test(threadHeader) ? threadHeader : `ziwei-${randomUUID()}`

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS)
  res.on('close', () => abort.abort())

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (payload) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  let emitted = false
  let errorSent = false
  let reasoningChars = 0
  try {
    const options = {
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      sessionId,
      signal: abort.signal,
    }
    // 面板要的是「打开就有话说」，不追求深度推理：显式压低思考强度。
    options.reasoningEffort = 'low'

    const debug = process.env.DSH_ZIWEI_AI_DEBUG === '1'

    /** 跑一轮流式生成；返回这一轮是否真的吐出了正文、以及结束原因。 */
    const runOnce = async (overrides) => {
      let gotText = false
      let reasonKind = ''
      const seen = []
      for await (const chunk of llm.stream({ ...options, ...overrides })) {
        if (debug) {
          seen.push(chunk.type === 'text-delta' ? `text:${chunk.text.slice(0, 20)}` : chunk.type)
          if (seen.length <= 12 || chunk.type === 'finish') {
            console.log('[ziwei-ai] chunk', chunk.type, JSON.stringify(chunk).slice(0, 300))
          }
        }
        if (chunk.type === 'reasoning-delta' && chunk.text) {
          reasoningChars += chunk.text.length
          send({ type: 'reasoning', chars: reasoningChars })
        } else if (chunk.type === 'text-delta' && chunk.text) {
          gotText = true
          emitted = true
          send({ type: 'delta', text: chunk.text })
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason || {}
          reasonKind = (reason.kind || '').toString()
          if (reason.kind === 'error' || reason.kind === 'aborted') {
            const failure = reason.failure || {}
            // 原始 failure 可能带 provider 地址/凭据提示，只留宿主日志。
            console.warn('[dsh-ziwei] 模型返回失败:', failure.message || reason.kind)
            send({
              type: 'error',
              message:
                reason.kind === 'aborted'
                  ? '解读被取消或超时了，再点一次即可。'
                  : '模型这次没有给出结果，请稍后重试。',
            })
            errorSent = true
          }
          break
        }
      }
      return { gotText, reasonKind }
    }

    let first = await runOnce({})
    // 只思考不落地：思考把输出预算吃光了（finish=max-tokens，或 stop 但正文为空）。
    // 放大预算、并要求模型直接给正文，重试一次再放弃。
    if (!first.gotText && !errorSent && !abort.signal.aborted) {
      if (debug) {
        console.log('[ziwei-ai] 首轮没有正文（finish=' + first.reasonKind + '），放大预算重试')
      }
      await runOnce({ maxTokens: RETRY_OUTPUT_TOKENS, system: SYSTEM_PROMPT + RETRY_HINT })
    }
    if (!emitted && !errorSent) {
      send({
        type: 'error',
        message:
          first.reasonKind === 'max-tokens'
            ? '这次思考用满了输出上限，没吐正文。再点一次，或把问题问得更具体些。'
            : '模型没有返回内容，稍后再试。',
      })
    }
    send({ type: 'done' })
  } catch (error) {
    const status = (error && error.statusCode) || 0
    console.error('[dsh-ziwei] 解读失败:', error)
    const message = abort.signal.aborted
      ? '解读超时或被取消，再点一次即可。'
      : status === 413
        ? error.message
        : status === 400
          ? '请求内容不完整，刷新页面后重试。'
          : '解读生成失败，请稍后再试。'
    send({ type: 'error', message })
  } finally {
    clearTimeout(timer)
    if (!res.writableEnded) res.end()
  }
}

/** /ziwei/ai 与 /ziwei/ai/... 都算 AI 路由。 */
export function isAiPath(url) {
  const path = (url || '').split('?')[0]
  return path === '/ziwei/ai' || path === '/ziwei/ai/' || path.startsWith('/ziwei/ai/')
}

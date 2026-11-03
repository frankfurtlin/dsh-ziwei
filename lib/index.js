/**
 * dsh-ziwei —— host 半：把本地紫微斗数应用（Next.js，127.0.0.1:8815）挂到
 * DSH Web 的 `/ziwei` 前缀下，并复用 DSH 自己的登录闸门。
 *
 * 设计要点：
 *  - 只在 127.0.0.1 上反代，不碰公网；Caddy 侧的 /ziwei 公网路由已删除。
 *  - 每个请求先过 `ctx.connection.requestRejection()`：它返回 403（Host/Origin
 *    不在信任围栏内）或 401（未通过浏览器登录），undefined 才放行。这样内嵌
 *    面板天然继承 DSH 的 token/cookie 会话，不需要另做一套认证。
 *  - 用 node:http 流式管道转发，保留 cookie、请求方法、状态码与 SSE 流式响应，
 *    以满足 app 的流式请求。
 *  - 例外：`/ziwei/ai` 不走反代，由本插件直接用 DSH 的模型能力（ctx.llm）生成
 *    解读并以 SSE 流回内嵌页 —— 应用自带的 AI 接口已删除，解读只用 DSH 的能力。
 */
import { request as httpRequest } from 'node:http'
import { handleAiRequest, isAiPath } from './ai.js'
import { clearBirthStore, clearCurrentBirth, readBirthStore, saveBirthRecord } from './birth-store.js'

const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSH_ZIWEI_UPSTREAM_PORT || 8815)
const ROUTE_PATH = '/ziwei'
/** 反代上游的超时（毫秒）：Next 正常响应远小于这个值。 */
const UPSTREAM_TIMEOUT_MS = 10_000

/** RFC 7230 hop-by-hop 头，不该被代理透传。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 转发给上游的请求头：剥掉逐跳头，补上 X-Forwarded-*。 */
function upstreamHeaders(req) {
  const out = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  out.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`
  out['x-forwarded-host'] = req.headers.host || `${UPSTREAM_HOST}:${UPSTREAM_PORT}`
  out['x-forwarded-proto'] = 'http'
  if (req.socket && req.socket.remoteAddress) {
    out['x-forwarded-for'] = req.socket.remoteAddress
  }
  return out
}

/** 上游响应头：同样剥掉逐跳头，交给 node 自己算 Transfer-Encoding。 */
function downstreamHeaders(upstreamRes) {
  const out = {}
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

function sendPlain(res, status, text) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendJson(res, statusCode, payload, extraHeaders = null) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

/**
 * 请求体超限：先回一个可读的 413，等响应真的写出去再断开连接。
 *
 * 之前是「先 req.destroy() 再回包」，客户端只会看到连接重置（curl 报 000），
 * 413 永远是死代码。
 */
function sendPayloadTooLarge(res, req, error) {
  sendJson(res, 413, { ok: false, error: (error && error.message) || '请求体过大' }, { connection: 'close' })
  res.on('finish', () => {
    try {
      req.destroy()
    } catch {}
  })
}

/** 鉴权闸门：没登录/主机不可信就直接挡掉，绝不把本地应用暴露出去。 */
function rejectUnprivileged(ctx, req, res) {
  let rejection
  try {
    const connection = ctx.get('connection', false)
    rejection = connection && typeof connection.requestRejection === 'function'
      ? connection.requestRejection(req)
      : 401
  } catch {
    rejection = 401
  }
  if (!rejection) return false
  const text = rejection === 403
    ? 'dsh web: 该请求的主机/来源不在信任列表内。\n'
    : 'dsh web authentication required; reopen the URL printed by dsh web.\n'
  sendPlain(res, rejection, text)
  return true
}

/** /ziwei/birth 及其子路径：生辰的服务端存储。 */
/** DELETE /ziwei/birth 的作用范围：'all' 才清历史，其余一律只清 current。 */
function birthScope(url) {
  const query = String(url || '').split('?')[1] || ''
  const value = new URLSearchParams(query).get('scope')
  return value === 'all' ? 'all' : 'current'
}

function isBirthPath(url) {
  const path = (url || '').split('?')[0]
  return path === '/ziwei/birth' || path === '/ziwei/birth/' || path.startsWith('/ziwei/birth/')
}

/** 读请求体（限制大小，避免有人拿插件当上传口）。 */
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

/**
 * 生辰的读写接口。
 *
 * 存储位置是宿主上的配置文件（默认 `~/.dsh/ziwei/birth.json`，0600），
 * 所以换浏览器、换设备都能恢复；写入的是本机文件，不出机器。
 */
async function handleBirthRequest(req, res) {
  try {
    if (req.method === 'GET') {
      const store = await readBirthStore()
      sendJson(res, 200, {
        ok: true,
        current: store.current,
        history: store.history,
        // 只回相对 DSH_HOME 的位置：绝对路径会漏出用户名与本机目录结构
        file: 'ziwei/birth.json',
      })
      return
    }
    if (req.method === 'POST') {
      const raw = await readBody(req)
      let payload = null
      try {
        payload = raw ? JSON.parse(raw) : null
      } catch {
        sendJson(res, 400, { ok: false, error: 'JSON 解析失败' })
        return
      }
      if (!payload || typeof payload !== 'object') {
        sendJson(res, 400, { ok: false, error: '缺少请求体' })
        return
      }
      const record = await saveBirthRecord(payload.info, payload.form)
      sendJson(res, 200, { ok: true, current: record, file: 'ziwei/birth.json' })
      return
    }
    if (req.method === 'DELETE') {
      // 默认只清 current（「忘记这个生辰」），历史列表保留；
      // ?scope=all 才是真的清空全部（验收脚本与本机重置用）。
      const scope = birthScope(req.url)
      if (scope === 'all') {
        await clearBirthStore()
        sendJson(res, 200, { ok: true, scope: 'all', current: null, history: [] })
        return
      }
      const store = await clearCurrentBirth()
      sendJson(res, 200, { ok: true, scope: 'current', current: null, history: store.history })
      return
    }
    res.writeHead(405, { allow: 'GET, POST, DELETE', 'content-type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed\n')
  } catch (error) {
    const status = (error && error.statusCode) || 500
    if (status === 413) {
      sendPayloadTooLarge(res, req, error)
      return
    }
    if (status >= 500) {
      console.error('[dsh-ziwei] 生辰接口内部错误:', error)
      sendJson(res, 500, { ok: false, error: '生辰存储暂时不可用，请稍后再试。' })
      return
    }
    sendJson(res, status, { ok: false, error: (error && error.message) || String(error) })
  }
}

/** /ziwei 前缀 → 上游 127.0.0.1:8815 的流式反代。 */
function createHandler(ctx) {
  return function ziweiProxy(req, res) {
    if (rejectUnprivileged(ctx, req, res)) return

    if (isBirthPath(req.url)) {
      // 必须兜住：这里裸调用过，一次未捕获异常就变成 unhandled rejection，
      // 在 Node 24 上会直接把整个 dsh 进程带崩（实测见过一次）。
      handleBirthRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          sendPlain(res, 500, `生辰存储异常：${(error && error.message) || error}\n`)
        } else if (!res.writableEnded) {
          res.end()
        }
      })
      return
    }

    if (isAiPath(req.url)) {
      handleAiRequest(ctx, req, res).catch((error) => {
        console.error('[dsh-ziwei] 解读接口内部错误:', error)
        if (!res.headersSent) {
          sendPlain(res, 500, '解读服务异常，请稍后再试。\n')
        } else if (!res.writableEnded) {
          res.end()
        }
      })
      return
    }

    const upstream = httpRequest(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, downstreamHeaders(upstreamRes))
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
      },
    )

    // 上游卡住（不响应）时不能把 handler 永久挂起：超时直接 504。
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(Object.assign(new Error('上游响应超时'), { code: 'ETIMEDOUT' }))
    })

    upstream.on('error', (error) => {
      if (error && error.code === 'ETIMEDOUT') {
        console.warn('[dsh-ziwei] 反代超时（10s）:', req.method, req.url)
        sendPlain(res, 504, '紫微斗数应用响应超时，请稍后重试。\n')
        return
      }
      const reason = error && error.code ? error.code : 'ECONNREFUSED'
      // 诊断信息只写宿主日志：回给浏览器的文案不带错误码、单元名、路径。
      console.warn(
        `[dsh-ziwei] 反代失败（${reason}）: ${req.method} ${req.url} → 127.0.0.1:${UPSTREAM_PORT}`,
      )
      sendPlain(res, 502, '紫微斗数应用暂时不可用，请稍后重试。\n')
    })

    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
}

export const name = 'dsh-ziwei'
export const inject = ['webServer']

export function apply(ctx) {
  const handler = createHandler(ctx)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler,
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-ziwei: /ziwei reverse proxy')
}

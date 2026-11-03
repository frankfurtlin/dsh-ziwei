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
import { birthFile, clearBirthStore, readBirthStore, saveBirthRecord } from './birth-store.js'

const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSH_ZIWEI_UPSTREAM_PORT || 8815)
const ROUTE_PATH = '/ziwei'

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
function isBirthPath(url) {
  const path = (url || '').split('?')[0]
  return path === '/ziwei/birth' || path === '/ziwei/birth/' || path.startsWith('/ziwei/birth/')
}

/** 读请求体（限制大小，避免有人拿插件当上传口）。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
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
      sendJson(res, 200, { ok: true, current: store.current, history: store.history, file: birthFile() })
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
      sendJson(res, 200, { ok: true, current: record, file: birthFile() })
      return
    }
    if (req.method === 'DELETE') {
      await clearBirthStore()
      sendJson(res, 200, { ok: true, current: null, history: [] })
      return
    }
    res.writeHead(405, { allow: 'GET, POST, DELETE', 'content-type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed\n')
  } catch (error) {
    const status = (error && error.statusCode) || 500
    sendJson(res, status, { ok: false, error: (error && error.message) || String(error) })
  }
}

/** /ziwei 前缀 → 上游 127.0.0.1:8815 的流式反代。 */
function createHandler(ctx) {
  return function ziweiProxy(req, res) {
    if (rejectUnprivileged(ctx, req, res)) return

    if (isBirthPath(req.url)) {
      handleBirthRequest(req, res)
      return
    }

    if (isAiPath(req.url)) {
      handleAiRequest(ctx, req, res).catch((error) => {
        if (!res.writableEnded) {
          sendPlain(res, 500, `紫微解读服务异常：${(error && error.message) || error}\n`)
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

    upstream.on('error', (error) => {
      const reason = error && error.code ? error.code : 'ECONNREFUSED'
      sendPlain(
        res,
        502,
        `紫微斗数应用暂时不可用（${reason}）。\n` +
          '请确认本地服务在跑：systemctl status dsh-ziwei-app.service\n',
      )
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

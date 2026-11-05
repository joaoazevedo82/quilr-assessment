import { createServer, request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { jwtVerify } from 'jose'

const port = Number(process.env.PORT ?? 8080)
const downstream = process.env.DOWNSTREAM_URL ?? 'http://localhost:8081'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret')
const maxBody = 1024 * 1024

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function reply(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

async function roleOf(auth?: string) {
  const token = auth?.match(/^Bearer (\S+)$/i)?.[1]
  if (!token) return
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    return typeof payload.role === 'string' ? payload.role : undefined
  } catch {
    return
  }
}

function isAdminCall(m: any) {
  if (m?.method !== 'tools/call') return false
  const name = m.params?.name
  // a name that isn't a plain string is refused too, the downstream might coerce it
  return typeof name !== 'string' || name.startsWith('admin_')
}

function forward(req: IncomingMessage, res: ServerResponse, body?: string) {
  // authorization is left out on purpose, the client token never reaches the downstream server
  const headers: Record<string, string> = {}
  for (const h of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))

  const up = request(new URL(req.url ?? '/', downstream), { method: req.method, headers }, (upRes) => {
    const out: Record<string, string> = {}
    for (const h of ['content-type', 'cache-control', 'mcp-session-id']) {
      const v = upRes.headers[h]
      if (typeof v === 'string') out[h] = v
    }
    res.writeHead(upRes.statusCode ?? 502, out)
    upRes.pipe(res)
  })
  up.on('error', (err) => {
    console.error(`downstream error: ${err.message}`)
    if (res.headersSent) res.destroy()
    else reply(res, 502, rpcError(null, -32603, 'Downstream server unavailable'))
  })
  // sse streams stay open, so drop the downstream request when the client goes away
  res.on('close', () => up.destroy())
  up.end(body)
}

createServer(async (req, res) => {
  const role = await roleOf(req.headers.authorization)
  if (!role) return reply(res, 401, rpcError(null, -32000, 'Missing or invalid bearer token'), { 'www-authenticate': 'Bearer error="invalid_token"' })

  if (req.method !== 'POST') return forward(req, res)

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const c of req) {
      size += c.length
      if (size > maxBody) return reply(res, 413, rpcError(null, -32600, 'Request body too large'))
      chunks.push(c)
    }
  } catch {
    // client hung up mid upload, nobody is left to answer
    return
  }

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return reply(res, 400, rpcError(null, -32700, 'Parse error'))
  }

  // every message of a batch is checked, and a batch with one denied call is refused as a whole
  const msgs = Array.isArray(body) ? body : [body]
  if (role !== 'admin' && msgs.some(isAdminCall)) {
    console.log(`denied ${msgs.filter(isAdminCall).map((m) => m.params?.name).join(', ')} for role ${role}`)
    const errs = msgs.map((m) => rpcError(m?.id, -32001, 'Unauthorized Tool Call'))
    return reply(res, 200, Array.isArray(body) ? errs : errs[0])
  }

  // forward what was inspected rather than the raw bytes, so duplicate keys can't mean something else downstream
  forward(req, res, JSON.stringify(body))
}).listen(port, () => console.log(`mcp gateway on http://localhost:${port}, forwarding to ${downstream}`))

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { admit, release, settle, tenantOf } from './limiter.ts'

const port = Number(process.env.PORT ?? 8100)
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 3000)
const defaultMaxTokens = 1024
const maxBody = 1024 * 1024
const providers = [
  { name: 'primary', url: process.env.PRIMARY_URL ?? 'http://localhost:8101', key: process.env.PRIMARY_API_KEY, model: process.env.PRIMARY_MODEL },
  { name: 'secondary', url: process.env.SECONDARY_URL ?? 'http://localhost:8102', key: process.env.SECONDARY_API_KEY, model: process.env.SECONDARY_MODEL },
]

// every error leaves in this one shape, upstream bodies and stack traces only go to the log
function fail(res: ServerResponse, id: string, status: number, code: string, message: string, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': id, ...headers })
  res.end(JSON.stringify({ error: { type: 'gateway_error', code, message, request_id: id } }))
}

type Attempt = { status: number; json: any } | { failed: string } | { aborted: true }

async function attempt(p: (typeof providers)[number], body: object, client: AbortSignal): Promise<Attempt> {
  // the timeout covers reading the body too, and it really closes the upstream request instead of leaving it running
  const signal = AbortSignal.any([client, AbortSignal.timeout(timeoutMs)])
  try {
    const res = await fetch(`${p.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(p.key && { authorization: `Bearer ${p.key}` }) },
      body: JSON.stringify(p.model ? { ...body, model: p.model } : body),
      signal,
    })
    if (res.status === 429 || res.status >= 500) return { failed: `answered ${res.status}: ${(await res.text()).slice(0, 200)}` }
    return { status: res.status, json: await res.json() }
  } catch (err) {
    if (client.aborted) return { aborted: true }
    const e = err as Error
    return { failed: e.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : `${e.message} (${(e.cause as { code?: string })?.code})` }
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, id: string) {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return fail(res, id, 404, 'not_found', 'Only POST /v1/chat/completions is served here')

  const key = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]
  const tenant = key ? tenantOf(key) : undefined
  if (!tenant) return fail(res, id, 401, 'invalid_api_key', 'Missing or unknown API key')

  let raw = ''
  try {
    for await (const c of req) {
      raw += c
      if (raw.length > maxBody) return fail(res, id, 413, 'request_too_large', 'Request body is over 1 MB')
    }
  } catch {
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(res, id, 400, 'invalid_request', 'Request body must be JSON')
  }
  if (!Array.isArray(body?.messages)) return fail(res, id, 400, 'invalid_request', 'messages must be an array')
  if (body.stream) return fail(res, id, 400, 'invalid_request', 'Streaming is not supported here, send stream: false')

  // about 4 chars per token for the prompt plus the most the model may write, settled to the real usage afterwards
  const cap = body.max_completion_tokens ?? body.max_tokens
  const estimate = Math.ceil(JSON.stringify(body.messages).length / 4) + (Number.isInteger(cap) && cap > 0 ? cap : defaultMaxTokens)
  if (estimate > tenant.max) return fail(res, id, 413, 'request_too_large', `Request could use ${estimate} tokens, over the limit of ${tenant.max} per minute`)

  const slot = admit(tenant.hash, tenant.max, estimate)
  if (!slot.ok) return fail(res, id, 429, 'rate_limit_exceeded', `Token limit of ${tenant.max} per minute reached`, { 'retry-after': String(slot.retryAfter) })

  const ac = new AbortController()
  res.on('close', () => ac.abort())

  for (const p of providers) {
    const r = await attempt(p, body, ac.signal)
    // the provider may already have spent tokens on it, so an abandoned request stays counted
    if ('aborted' in r) return
    if ('failed' in r) {
      console.error(`${id} ${p.name} ${r.failed.replace(/\s+/g, ' ')}`)
      continue
    }
    if (r.status >= 400) {
      release(slot.id)
      console.error(`${id} ${p.name} rejected the request with ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`)
      return fail(res, id, r.status === 400 || r.status === 422 ? 400 : 502, 'upstream_rejected', 'The model provider rejected the request')
    }
    const used = r.json?.usage?.total_tokens
    settle(slot.id, typeof used === 'number' ? used : estimate)
    console.log(`${id} ${tenant.name} served by ${p.name}, ${used ?? estimate} tokens`)
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': id, 'x-provider': p.name })
    return void res.end(JSON.stringify(r.json))
  }

  release(slot.id)
  fail(res, id, 503, 'providers_unavailable', 'No model provider could answer, try again shortly')
}

createServer(async (req, res) => {
  const id = randomUUID()
  try {
    await handle(req, res, id)
  } catch (err) {
    console.error(`${id} ${(err as Error).stack}`)
    if (res.headersSent) res.destroy()
    else fail(res, id, 500, 'internal_error', 'The gateway hit an unexpected error')
  }
}).listen(port, () => console.log(`llm router on http://localhost:${port}/v1/chat/completions`))

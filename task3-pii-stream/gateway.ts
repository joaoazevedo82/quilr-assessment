import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createParser } from 'eventsource-parser'
import { createRedactor, redact } from './redact.ts'

const port = Number(process.env.PORT ?? 8090)
const upstream = process.env.UPSTREAM_URL ?? 'http://localhost:8091'
const apiKey = process.env.UPSTREAM_API_KEY

function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'gateway_error' } }))
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return fail(res, 404, 'Not found')

  let raw = ''
  try {
    for await (const c of req) raw += c
  } catch {
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(res, 400, 'Request body must be JSON')
  }

  const ac = new AbortController()
  res.on('close', () => ac.abort())

  let up: Response
  try {
    up = await fetch(`${upstream}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
      body: raw,
      signal: ac.signal,
    })
  } catch (err) {
    if (!ac.signal.aborted) console.error(`upstream unreachable: ${(err as Error).message}`)
    return fail(res, 502, 'Upstream unavailable')
  }
  if (!up.ok || !up.body) {
    console.error(`upstream answered ${up.status}`)
    return fail(res, up.status < 500 ? up.status : 502, 'Upstream request failed')
  }

  if (!body.stream) {
    const json = await up.json()
    for (const c of json.choices ?? []) if (typeof c.message?.content === 'string') c.message.content = redact(c.message.content)
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json))
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  res.flushHeaders()

  // one redactor per choice, n > 1 interleaves choices in the same stream
  const redactors = new Map<number, ReturnType<typeof createRedactor>>()
  let last: any
  let out = ''

  const flush = () => {
    for (const [index, r] of redactors) {
      const text = r.end()
      if (text) out += `data: ${JSON.stringify({ ...last, choices: [{ index, delta: { content: text }, finish_reason: null }] })}\n\n`
    }
    redactors.clear()
  }

  const parser = createParser({
    onEvent(ev) {
      if (ev.data === '[DONE]') {
        flush()
        out += 'data: [DONE]\n\n'
        return
      }

      let chunk
      try {
        chunk = JSON.parse(ev.data)
      } catch {
        out += `data: ${ev.data}\n\n`
        return
      }

      for (const c of chunk.choices ?? []) {
        let r = redactors.get(c.index)
        if (!r) redactors.set(c.index, (r = createRedactor()))
        let text = typeof c.delta?.content === 'string' ? r.push(c.delta.content) : ''
        if (c.finish_reason) {
          text += r.end()
          redactors.delete(c.index)
        }
        if (text || typeof c.delta?.content === 'string') c.delta = { ...c.delta, content: text }
      }
      last = chunk
      out += `data: ${JSON.stringify(chunk)}\n\n`
    },
  })

  const dec = new TextDecoder()
  try {
    for await (const bytes of up.body) {
      parser.feed(dec.decode(bytes, { stream: true }))
      const s = out
      out = ''
      if (s && !res.write(s)) await once(res, 'drain', { signal: ac.signal })
    }
    flush()
    res.end(out)
  } catch (err) {
    if (ac.signal.aborted) return
    // held text is dropped here, it could be the first half of an email or card number
    console.error(`upstream stream broke: ${(err as Error).message}`)
    res.end(`data: ${JSON.stringify({ error: { message: 'Upstream stream interrupted', type: 'gateway_error' } })}\n\n`)
  }
}).listen(port, () => console.log(`llm gateway on http://localhost:${port}/v1/chat/completions, upstream ${upstream}`))

import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

const port = Number(process.env.PORT ?? 8091)

const answer =
  'Sure. The customer on file is Jane Roe, email jane.roe@acme-corp.com, SSN 078-05-1120. ' +
  'The order was paid with card 4111 1111 1111 1111 and the backup contact is ops+billing@acme.io. ' +
  'Order 2024-11-05 shipped, nothing else to flag.'

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end()

  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw)
  const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-1' }

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }))
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (delta: object, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)

  send({ role: 'assistant', content: '' })
  // uneven small pieces, roughly how real token deltas split words and numbers
  const sizes = [3, 5, 2, 4, 6, 1]
  for (let i = 0, k = 0; i < answer.length && !res.destroyed; k++) {
    const n = sizes[k % sizes.length]
    send({ content: answer.slice(i, i + n) })
    i += n
    await sleep(30)
  }
  send({}, 'stop')
  res.end('data: [DONE]\n\n')
}).listen(port, () => console.log(`mock llm on http://localhost:${port}/v1/chat/completions`))

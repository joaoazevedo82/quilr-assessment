import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

// mode: ok, slow (answers after MOCK_DELAY_MS), ratelimit (429) or error (500 with a stack trace)
const [name = 'primary', port = '8101', mode = 'ok'] = process.argv.slice(2)
const delay = Number(process.env.MOCK_DELAY_MS ?? 5000)

createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw)
  console.log(`${name} got a request (${mode})`)

  if (mode === 'ratelimit') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' })
    return void res.end(JSON.stringify({ error: { message: 'Rate limit reached for org-8f2a on tokens per min (TPM): Limit 200000', type: 'tokens' } }))
  }
  if (mode === 'error') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    return void res.end('Traceback (most recent call last):\n  File "/srv/inference/worker.py", line 88, in generate\nRuntimeError: CUDA out of memory on gpu-node-17.internal')
  }
  if (mode === 'slow') await sleep(delay)

  const content = `Hello from the ${name} provider.`
  const prompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4)
  // spends the whole max_tokens budget so the rate limit is easy to hit by hand
  const completion = body.max_tokens ?? 100
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? `${name}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  }))
}).listen(Number(port), () => console.log(`mock ${name} provider on http://localhost:${port} (${mode})`))

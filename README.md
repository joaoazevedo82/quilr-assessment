# Quilr assessment

My solutions for the AI Field Developer take home. Everything is TypeScript on Node 24, which runs `.ts` files directly, so there's no build step.

```
npm install
npm run check     # type check only, nothing is emitted
```

## Task 1: MCP server over stdio

Code is in `task1-mcp-server/server.ts`. Two tools, `get_customer_record` and `trigger_refund`, backed by two fake customers (`CUST-10001`, `CUST-10002`).

Quick check without any client:

```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"bad"}}}' | node task1-mcp-server/server.ts
```

Or with the inspector: `npx @modelcontextprotocol/inspector node task1-mcp-server/server.ts`

Some notes:

- Validation is zod with strict objects, so unknown keys are rejected too. `amount` has to be positive, in whole cents and at most 1,000,000 (`1e999` parses to Infinity and gets rejected too), `reason` is trimmed before the 10 character check so ten spaces don't count.
- Bad input comes back as a JSON-RPC error with code `-32602`, with the zod issues in `error.data`. An unknown tool name is `-32602` as well, and so is a broken `params` object (say `arguments: null`), which the SDK would otherwise answer with `-32603`.
- I used the low level `Server` class instead of `McpServer.registerTool`. With `registerTool` the SDK turns validation failures into a normal result with `isError: true`, which isn't what the task asks for.
- A well formed id that doesn't exist is a tool error (`isError: true`), not a protocol error, since the request itself was fine.
- stdout only ever carries JSON-RPC. Logs go to stderr, and `console.log` is pointed at stderr at startup in case some dependency prints.
- The SDK silently drops lines it can't parse. The server answers those with `-32700` (not JSON) or `-32600` (JSON but not a valid message) and an `id` of null, like JSON-RPC says.

Worth knowing: the latest MCP spec leans towards returning input validation problems as tool errors so the model can fix its call and retry. I stuck with `-32602` because that's what the task asked for, but switching is a few lines.

## Task 2: MCP gateway

`task2-mcp-gateway/` has the gateway, a mock downstream MCP server (Streamable HTTP, built with the SDK) and a script that mints test tokens. Run each in its own terminal:

```
npm run task2:downstream        # mock MCP server on :8081
npm run task2:gateway           # gateway on :8080
```

Then, from bash:

```
TOKEN=$(npm run -s task2:token -- viewer)    # or admin

curl -s localhost:8080/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"key_id":"k1"}}}'
```

As a viewer that returns `{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized Tool Call"}}` and the downstream never sees the call. As admin it goes through. Pointing the official SDK client at `http://localhost:8080/mcp` works the same way.

How it works:

- The token is an HS256 JWT with a `role` claim, checked with `jose` with the algorithm pinned (so `alg: none` tokens fail), plus issuer and audience so a token minted for something else is refused. The secret comes from `JWT_SECRET` and falls back to `dev-secret` for local runs, with a warning at startup. `JWT_ISSUER` and `JWT_AUDIENCE` default to `demo-issuer` and `mcp-gateway`. Missing or bad token gets a 401.
- A denied call gets HTTP 200 with the `-32001` JSON-RPC error. I tried 403 first, but the SDK client then throws a generic HTTP error and the JSON-RPC code is lost. With 200 the caller gets an `McpError` with code `-32001`.
- Everything else is forwarded as is: SSE responses are streamed through, GET and DELETE pass, and so do the session headers. The client's `Authorization` header is not sent downstream.
- Batches: the SDK server still accepts JSON arrays, so only looking at `body.method` would let an admin call ride along with a `tools/list`. Every message gets checked and a batch with a denied call is refused as a whole.
- The gateway forwards the JSON it parsed, not the raw bytes. Otherwise a body with two `name` keys could be read one way here and another way downstream.
- The `admin_` check ignores case and leading spaces, and a tool name that isn't a plain string is treated as an admin call for non admins. Denials are logged with the token subject.
- A client that drops the connection halfway through sending a body just gets ignored. Early on this crashed the whole gateway.
- `tools/list` is passed through untouched like the task says, so viewers still see the admin tools listed. Hiding them would be easy to add.

## Task 3: PII redaction on a streamed LLM response

`task3-pii-stream/` has the gateway, the redactor and a mock LLM that streams OpenAI style chunks with an email, an SSN and card numbers mixed into the text.

```
npm run task3:mock       # mock llm on :8091
npm run task3:gateway    # gateway on :8090

curl -N localhost:8090/v1/chat/completions -d '{"model":"x","stream":true,"messages":[]}'
```

To use a real provider instead, set `UPSTREAM_URL` (for example `https://api.openai.com`) and `UPSTREAM_API_KEY`. The request body is forwarded as is.

The tricky part is that PII gets split across chunks. `jane.roe@ac` arrives in one delta and `me-corp.com` in the next, so redacting each chunk on its own leaks most of it. Holding back a fixed number of characters works, but adds a lot of delay and is easy to get subtly wrong.

What `redact.ts` does instead:

- After each chunk it scans the buffer, replaces complete matches, and sends everything up to the point where something at the end could still turn into a match. Only that tail stays behind. In normal prose that's the word currently being written, so the client sees text almost as fast as the model produces it.
- A match touching the end is held too, since `a@b.co` could still become `a@b.com`.
- One already sent character stays in the buffer, so the `(?<!\d)` checks still know what came before.
- The buffer can never grow past about 330 characters (the longest possible email), so memory is flat however long the response is.
- When the stream finishes, the tail is redacted and sent. If the upstream breaks in the middle, the tail is dropped instead and the client gets an error event, because it might be half a card number.

I checked it by comparing the streamed output with redacting the whole text in one go, over 143 sample texts with every 2 way split, one character per chunk, and 300 random chunkings each (about 52k runs, no differences). It does about 6 MB/s, which is a long way above what any model streams.

The gateway itself parses the SSE stream with `eventsource-parser`, keeps one redactor per choice (`n > 1` interleaves them), respects backpressure, and aborts the upstream request when the client disconnects. Non streaming responses are redacted in one pass.

Things I left out: no Luhn check on card numbers (so a 16 digit order id gets redacted too, which seemed the safer mistake), no phone numbers or names, and tool call arguments aren't scanned, only `delta.content`.

## Task 4: rate limits and model fallback

`task4-rate-limit/` has the router, the SQLite limiter, a script that creates tenant keys and a mock provider that can be told to misbehave.

```
npm run task4:primary              # mock primary on :8101, add "-- slow", "-- ratelimit" or "-- error"
npm run task4:secondary            # mock secondary on :8102
npm run task4:gateway              # router on :8100

KEY=$(npm run -s task4:tenant -- acme)        # optional second arg is the tokens per minute, default 50000

curl -s -i localhost:8100/v1/chat/completions \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"x","messages":[{"role":"user","content":"hi"}],"max_tokens":20000}'
```

Run the curl three times and the third one gets a 429 with `Retry-After`. Restart the primary with `-- slow` and requests come back from the secondary after 3 seconds (the `x-provider` header says which one answered). For real providers set `PRIMARY_URL`, `SECONDARY_URL`, the matching `*_API_KEY` and optionally `*_MODEL` if the backup needs a different model name. The database goes to `task4-rate-limit/gateway.db` unless `DB_PATH` is set.

### Rate limiter

- Tenants live in a `tenants` table, keyed by the SHA-256 of their API key, so the key itself is never stored. Each has its own tokens per minute.
- Every request is a row in `usage` with a timestamp and a token count. The window is a real sliding one: a request is allowed when the rows of the last 60 seconds plus this request stay under the limit. No fixed buckets, so there's no double burst at a minute boundary.
- The token count isn't known until the model answers, so the gateway reserves an estimate up front (about 4 characters per token for the prompt, plus `max_tokens`, or 1024 if it's not set) and corrects the row to `usage.total_tokens` afterwards. Reserving first is what stops 30 parallel requests from all passing the check before any of them is counted. I fired 30 at once with 5000 tokens each and exactly 9 got through.
- The check and the insert run in one `BEGIN IMMEDIATE` transaction, which takes the write lock straight away. That also covers several gateway processes sharing the file: 6 processes hammering one tenant at the same time admitted exactly 50,000 tokens, in every run.
- Old rows are deleted inside the same transaction. The limit check filters by timestamp anyway, so eviction is only cleanup and can't make the count wrong.
- `Retry-After` on a 429 is exact: a window function finds the oldest row whose expiry frees enough room for this request.
- If no provider answers the reservation is released. If the client disconnects it stays, since the provider may already have spent the tokens.
- One thing I hit: SQLite's default `synchronous = FULL` meant an fsync per commit, about 30 ms on this machine, and with several processes the waiting ones starved until `busy_timeout` ran out. In WAL mode `NORMAL` is the usual setting and fixed both.

### Fallback

- Each provider call gets `AbortSignal.any([client, AbortSignal.timeout(3000)])`. The timeout covers the whole response, body included, and when it fires the upstream request is really closed. With a `Promise.race` against a timer the slow request keeps running in the background, and if it finishes late it can try to answer a response that's already been sent.
- The gateway falls back on a 429, a 5xx, a timeout, or a provider it can't reach. Other 4xx responses are not retried, since the secondary would reject the same request.
- A client disconnect aborts the call and does not trigger the fallback. The two cases are told apart by which signal fired.
- A provider that just failed is skipped for a while (its `Retry-After`, capped at 60 s, or 10 s), so with a dead primary only the first request waits out the 3 seconds. The last provider is always tried.
- I tested the primary answering 2900, 2980, 2995, 3000, 3005, 3020 and 3100 ms after the request. Every request got exactly one answer, from one provider, and nothing in the logs.

### Errors

Every error from the gateway has the same shape:

```json
{"error":{"type":"gateway_error","code":"rate_limit_exceeded","message":"Token limit of 50000 per minute reached","request_id":"..."}}
```

Codes are `invalid_api_key` (401), `invalid_request` (400), `request_too_large` (413), `rate_limit_exceeded` (429), `upstream_rejected` (400 or 502), `providers_unavailable` (503), `not_found` (404) and `internal_error` (500). Upstream bodies, status lines and stack traces go to the gateway log next to the request id, never to the client. The mock's `error` mode sends back a Python traceback with an internal hostname to check that. Anything unexpected inside the handler ends as `internal_error` instead of a crash.

Left out: streaming (Task 3 covers that, and falling back halfway through a stream isn't really possible), real tokenizers (the estimate is corrected after every call anyway), and per model limits.

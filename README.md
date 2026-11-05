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

- Validation is zod with strict objects, so unknown keys are rejected too. `amount` has to be a positive finite number (`1e999` parses to Infinity and gets rejected), `reason` is trimmed before the 10 character check so ten spaces don't count.
- Bad input comes back as a JSON-RPC error with code `-32602`, with the zod issues in `error.data`. An unknown tool name is `-32602` as well.
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

- The token is an HS256 JWT with a `role` claim, checked with `jose` with the algorithm pinned (so `alg: none` tokens fail). The secret comes from `JWT_SECRET` and falls back to `dev-secret` for local runs. Missing or bad token gets a 401.
- A denied call gets HTTP 200 with the `-32001` JSON-RPC error. I tried 403 first, but the SDK client then throws a generic HTTP error and the JSON-RPC code is lost. With 200 the caller gets an `McpError` with code `-32001`.
- Everything else is forwarded as is: SSE responses are streamed through, GET and DELETE pass, and so do the session headers. The client's `Authorization` header is not sent downstream.
- Batches: the SDK server still accepts JSON arrays, so only looking at `body.method` would let an admin call ride along with a `tools/list`. Every message gets checked and a batch with a denied call is refused as a whole.
- The gateway forwards the JSON it parsed, not the raw bytes. Otherwise a body with two `name` keys could be read one way here and another way downstream.
- A tool name that isn't a plain string is treated as an admin call for non admins.
- `tools/list` is passed through untouched like the task says, so viewers still see the admin tools listed. Hiding them would be easy to add.

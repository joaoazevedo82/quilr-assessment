import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 8081)

function mcpServer() {
  const server = new McpServer({ name: 'mock-downstream', version: '1.0.0' })

  server.registerTool('get_status', { description: 'Service health' }, async () => ({
    content: [{ type: 'text', text: 'all systems normal' }],
  }))

  server.registerTool('admin_reset_key', { description: 'Rotate an API key', inputSchema: { key_id: z.string() } }, async ({ key_id }) => {
    console.log(`admin_reset_key called for ${key_id}`)
    return { content: [{ type: 'text', text: `key ${key_id} rotated` }] }
  })

  return server
}

// stateless, so every POST gets its own server and transport
createServer(async (req, res) => {
  if (req.method !== 'POST') return void res.writeHead(405).end()

  const server = mcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => server.close())
  await server.connect(transport)
  await transport.handleRequest(req, res)
}).listen(port, () => console.log(`mock downstream mcp on http://localhost:${port}/mcp`))

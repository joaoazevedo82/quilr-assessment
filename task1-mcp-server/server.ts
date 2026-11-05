import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// stdout carries json-rpc only, so anything that still calls console.log ends up on stderr
console.log = console.info = console.debug = console.error

const log = (msg: string) => process.stderr.write(`[task1] ${msg}\n`)

const customerId = z.string().regex(/^CUST-\d{5}$/, 'customer_id must look like CUST-12345')

const tools = {
  get_customer_record: {
    description: 'Look up a customer record by id',
    schema: z.strictObject({ customer_id: customerId }),
  },
  trigger_refund: {
    description: 'Issue a refund to a customer',
    schema: z.strictObject({
      customer_id: customerId,
      amount: z.number().positive().multipleOf(0.01).max(1_000_000),
      reason: z.string().trim().min(10).max(500),
    }),
  },
}

const customers = new Map([
  ['CUST-10001', { name: 'Ada Lovelace', email: 'ada@example.com', plan: 'pro' }],
  ['CUST-10002', { name: 'Alan Turing', email: 'alan@example.com', plan: 'free' }],
])
const refunds: object[] = []

const server = new Server({ name: 'customer-support', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) as { type: 'object' },
  })),
}))

// loose schema so malformed params get the sdk's -32602 check instead of failing the strict parse with -32603
server.setRequestHandler(z.looseObject({ method: z.literal('tools/call') }), async (req) => {
  const { name, arguments: args } = CallToolRequestSchema.parse(req).params
  if (!Object.hasOwn(tools, name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)

  const parsed = tools[name as keyof typeof tools].schema.safeParse(args ?? {})
  if (!parsed.success) {
    log(`rejected ${name}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  const input = parsed.data as { customer_id: string; amount?: number; reason?: string }
  const customer = customers.get(input.customer_id)
  if (!customer) return { isError: true, content: [{ type: 'text', text: `Customer ${input.customer_id} not found` }] }

  if (name === 'get_customer_record') {
    return { content: [{ type: 'text', text: JSON.stringify({ customer_id: input.customer_id, ...customer }) }] }
  }

  const refund = { refund_id: `RF-${refunds.length + 1}`, ...input, status: 'queued' }
  refunds.push(refund)
  log(`refund ${refund.refund_id} for ${input.customer_id}`)
  return { content: [{ type: 'text', text: JSON.stringify(refund) }] }
})

const transport = new StdioServerTransport()

// the sdk drops lines it can't parse, json-rpc wants an error back with a null id
server.onerror = (err) => {
  log(`${err.name}: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}`)
  if (err instanceof SyntaxError) transport.send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'Parse error' } } as never)
  else if (err.name === 'ZodError') transport.send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'Invalid Request' } } as never)
}

await server.connect(transport)
log('listening on stdio')

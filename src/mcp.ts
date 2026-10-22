import { ACTIONS, ActionError, inputSchema, type Ctx } from './actions'
import type { Actions } from './module'

// MCP over plain HTTP POST, JSON in and JSON out, with no session to keep.
// The tools are the actions, so an agent gets the same list the page uses.

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

const INSTRUCTIONS = `A shared work tracker. People and agents use the same actions.
Give a why with every change; it goes in the history people read.
Only people close work: close_item from an agent becomes an ask, and nothing changes until a person approves it.
Use list_people for the ids to assign work to, and get_item before changing something you haven't read.`

interface RpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export const tools = () => ACTIONS.map(a => ({
  name: a.name,
  description: a.description,
  inputSchema: inputSchema(a),
  annotations: { readOnlyHint: !a.changes, destructiveHint: false, idempotentHint: !a.changes, openWorldHint: false },
}))

export async function mcp(request: Request, ctx: Ctx, actions: Actions): Promise<Response> {
  let msg: RpcRequest
  try { msg = await request.json() } catch { return rpcError(null, -32700, 'That body is not JSON.') }
  if (Array.isArray(msg) || typeof msg !== 'object' || msg === null) return rpcError(null, -32600, 'Send one JSON-RPC request per POST.')
  const { id = null, method = '', params = {} } = msg
  const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result })

  // Notifications (no id) get no answer.
  if (method.startsWith('notifications/')) return new Response(null, { status: 202 })
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return reply({
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'work-tracker', version: '0.1.0' },
      instructions: INSTRUCTIONS,
    })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: tools() })
  if (method === 'tools/call') {
    try {
      const result = await actions.perform(String(params.name ?? ''), params.arguments ?? {}, ctx)
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    } catch (err) {
      // A refused or failed action is a tool result the agent can read and act on, not a protocol error.
      if (err instanceof ActionError) return reply({ content: [{ type: 'text', text: err.message }], isError: true })
      throw err
    }
  }
  return rpcError(id, -32601, `There's no method called "${method}".`)
}

export const rpcError = (id: number | string | null, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })

import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIONS } from '../src/actions'
import { call, fetchWorker, reset, rpc } from './helpers'

beforeEach(reset)

describe('/mcp', () => {
  it('needs a token', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401)
    expect((await rpc('wrong', 'tools/list')).status).toBe(401)
    expect((await fetchWorker('/mcp')).status).toBe(405)
  })

  it('initialises with the rules in its instructions', async () => {
    const { body } = await rpc('bot-token', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'work-tracker' } })
    expect(body.result.instructions).toMatch(/Only people close work/)
    expect((await rpc('bot-token', 'initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-11-25')
    expect((await rpc('bot-token', 'notifications/initialized')).status).toBe(202)
  })

  it('lists the actions as tools, marking which only read', async () => {
    const { tools } = (await rpc('bot-token', 'tools/list')).body.result
    expect(tools.map((t: { name: string }) => t.name)).toEqual(ACTIONS.map(a => a.name))
    const byName = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t]))
    expect(byName.list_work.annotations.readOnlyHint).toBe(true)
    expect(byName.close_item.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.add_item.inputSchema).toMatchObject({ type: 'object', required: ['title'], additionalProperties: false })
    expect(byName.add_item.inputSchema.properties.why.description).toMatch(/Required from agents/)
  })

  it('runs the same actions as the HTTP API, with the same rules', async () => {
    const added = await rpc('bot-token', 'tools/call', { name: 'add_item', arguments: { title: 'Chase the Nguyen invoice', why: 'Unpaid 30 days' } })
    expect(added.body.result.structuredContent).toMatchObject({ message: 'Added #1 Chase the Nguyen invoice', item: { id: 1, created_by: 'triage-bot' } })
    expect(JSON.parse(added.body.result.content[0].text)).toEqual(added.body.result.structuredContent)

    // A refusal is a result the agent reads, not a protocol error.
    const noWhy = await rpc('bot-token', 'tools/call', { name: 'move_item', arguments: { item: 1, to: 'doing' } })
    expect(noWhy.body.result).toEqual({ content: [{ type: 'text', text: 'Nothing changed: agents give a why with every change, so the history makes sense later.' }], isError: true })

    const close = await rpc('bot-token', 'tools/call', { name: 'close_item', arguments: { item: 1, as: 'done', why: 'Paid this morning' } })
    expect(close.body.result.structuredContent).toMatchObject({ waiting: true, ask: 1 })
    expect((await call('sam-token', 'list_asks')).body.asks).toHaveLength(1)
  })

  it('answers unknown methods and bad JSON with JSON-RPC errors', async () => {
    expect((await rpc('bot-token', 'resources/list')).body.error.code).toBe(-32601)
    const bad = await fetchWorker('/mcp', { method: 'POST', headers: { authorization: 'Bearer bot-token' }, body: '{' })
    expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32700)
  })
})

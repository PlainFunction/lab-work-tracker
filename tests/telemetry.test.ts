import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryTelemetry, Telemetry } from '#capabilities'
import { TrackerModule } from '../src/module'
import { handle } from '../src/worker'
import { ORIGIN, reset } from './helpers'

beforeEach(reset)

function traced() {
  const t = new MemoryTelemetry({ serviceName: 'pf-work-tracker', serviceVersion: '0.1.0', environment: 'test', client: 'work-tracker' })
  const c = new TrackerModule({ DB: env.DB }).build().bind(Telemetry, () => t)
  const post = (path: string, token: string, body: unknown) => handle(c, new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { DB: env.DB })
  return { t, post }
}

describe('telemetry', () => {
  it('traces each request and the action it runs, by route and name, and logs it', async () => {
    const { t, post } = traced()
    expect((await post('/api/actions/add_item', 'sam-token', { title: 'Fix the gate latch' })).status).toBe(200)
    const [action, root] = t.finishedSpans
    expect(root).toMatchObject({ name: 'POST /api/actions/:name', kind: 'server', attrs: { 'http.route': '/api/actions/:name', 'http.response.status_code': 200 } })
    expect(action).toMatchObject({ name: 'Actions.perform', parentSpanId: root.spanId, attrs: { 'pf.action': 'add_item', 'pf.actor.kind': 'person' } })
    expect(t.bufferedLogs).toMatchObject([{ severity: 'info', body: 'http.request', spanId: root.spanId }])
    // Nothing anyone typed reaches telemetry.
    expect(JSON.stringify([t.finishedSpans, t.bufferedLogs])).not.toContain('gate latch')
  })

  it('names an action it has never heard of "unknown", not whatever was asked for', async () => {
    const { t, post } = traced()
    await post('/mcp', 'bot-token', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_tables', arguments: {} } })
    expect(t.finishedSpans.find(s => s.name === 'Actions.perform')?.attrs['pf.action']).toBe('unknown')
    expect(t.finishedSpans.at(-1)?.name).toBe('POST /mcp')
  })
})

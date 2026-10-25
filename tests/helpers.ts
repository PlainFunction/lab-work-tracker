import { env } from 'cloudflare:workers'
import schema from '../schema.sql?raw'
import worker, { sha256Hex } from '../src/worker'

export const ORIGIN = 'https://work.example'

/** A fresh database with one person and one agent, like `npm run token` makes. */
export async function reset() {
  const statements = schema.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)
  // Dropped, not emptied: AUTOINCREMENT would carry on numbering from the last test.
  await env.DB.batch(['settings', 'asks', 'events', 'items', 'token_limits', 'actors'].map(t => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)))
  await env.DB.batch(statements.map(s => env.DB.prepare(s)))
  const add = async (id: string, name: string, kind: string, token: string) =>
    env.DB.prepare("INSERT INTO actors (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, '2026-10-18T00:00:00Z')").bind(id, name, kind, await sha256Hex(token)).run()
  await add('sam', 'Sam', 'person', 'sam-token')
  await add('triage-bot', 'Triage bot', 'agent', 'bot-token')
}

export const fetchWorker = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), { DB: env.DB })

type Body = Record<string, any>

/** Calls an action over the HTTP API with a Bearer token. */
export async function call(token: string, name: string, args: unknown = {}): Promise<{ status: number; body: Body }> {
  const res = await fetchWorker(`/api/actions/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json() as Body }
}

let rpcId = 0
/** One JSON-RPC request to /mcp, as an MCP client sends it. */
export async function rpc(token: string | null, method: string, params: unknown = {}): Promise<{ status: number; body: Body }> {
  const res = await fetchWorker('/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Body : {} }
}

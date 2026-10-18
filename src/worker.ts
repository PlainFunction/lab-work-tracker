import { ActionError, describeActions, perform, type Actor } from './actions'
import { mcp, rpcError } from './mcp'

// Only /api/* and /mcp reach this Worker. The page is static assets.
//
//   POST /api/session          a person's token in, an HttpOnly cookie out
//   GET  /api/me               who the cookie or token belongs to
//   GET  /api/actions          every action, with the JSON Schema of its input
//   POST /api/actions/<name>   run one (cookie for people, Bearer token for anyone)
//   POST /mcp                  the same actions as MCP tools (Bearer token)

export interface Env { DB: D1Database }

const COOKIE = 'wt_session'
const SESSION_DAYS = 30

export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function actorFor(db: D1Database, token: string): Promise<Actor | null> {
  if (!token || token.length > 200) return null
  return db.prepare('SELECT id, name, kind FROM actors WHERE token_hash = ?').bind(await sha256Hex(token)).first<Actor>()
}

const cookieToken = (request: Request) =>
  (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''

const bearer = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''

/**
 * Agents send a Bearer token. People use the cookie, and only people get one.
 * A cookie rides along on cross-site requests, so those must be JSON from our own origin.
 */
async function who(request: Request, url: URL, db: D1Database): Promise<Actor | null> {
  const token = bearer(request)
  if (token) return actorFor(db, token)
  const fromCookie = cookieToken(request)
  if (!fromCookie) return null
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (origin && origin !== url.origin) return null
    if (!request.headers.get('content-type')?.startsWith('application/json')) return null
  }
  const a = await actorFor(db, fromCookie)
  return a?.kind === 'person' ? a : null
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

const cookie = (url: URL, value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`

async function readJson(request: Request): Promise<unknown> {
  try { return await request.json() } catch { throw new ActionError(400, 'Nothing changed: the body was not JSON.') }
}

async function api(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/session' && request.method === 'POST') {
    const { token } = (await readJson(request) ?? {}) as { token?: unknown }
    const a = typeof token === 'string' ? await actorFor(env.DB, token.trim()) : null
    if (!a) return json({ ok: false, error: "That token didn't work. Ask whoever runs the tracker for a new one." }, 401)
    if (a.kind !== 'person') return json({ ok: false, error: "That's an agent's token. Agents use the API or MCP, not this page." }, 403)
    return json({ ok: true, you: a }, 200, { 'set-cookie': cookie(url, token as string, SESSION_DAYS * 86400) })
  }
  if (url.pathname === '/api/session' && request.method === 'DELETE') {
    return json({ ok: true }, 200, { 'set-cookie': cookie(url, '', 0) })
  }

  const actor = await who(request, url, env.DB)
  if (!actor) return json({ ok: false, error: 'Sign in first: send a token as "Authorization: Bearer <token>".' }, 401)

  if (url.pathname === '/api/me' && request.method === 'GET') return json({ ok: true, you: actor })
  if (url.pathname === '/api/actions' && request.method === 'GET') return json({ ok: true, actions: describeActions() })
  const name = /^\/api\/actions\/([a-z_]+)$/.exec(url.pathname)?.[1]
  if (name && request.method === 'POST') {
    const result = await perform(name, await readJson(request), { db: env.DB, actor, now: new Date() })
    return json({ ok: true, ...result })
  }
  return json({ ok: false, error: `There's nothing at ${request.method} ${url.pathname}.` }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        const token = bearer(request)
        const actor = token ? await actorFor(env.DB, token) : null
        if (!actor) return rpcError(null, -32001, 'Send a token as "Authorization: Bearer <token>".', 401)
        return await mcp(request, { db: env.DB, actor, now: new Date() })
      }
      if (url.pathname.startsWith('/api/')) return await api(request, url, env)
      return new Response('Not found', { status: 404 })
    } catch (err) {
      if (err instanceof ActionError) return json({ ok: false, error: err.message }, err.status)
      console.error(err)
      return json({ ok: false, error: 'Something went wrong on our side. Check the history before trying again.' }, 500)
    }
  },
} satisfies ExportedHandler<Env>

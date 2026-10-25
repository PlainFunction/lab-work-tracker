import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { ORIGIN, call, fetchWorker, reset, rpc } from './helpers'

beforeEach(reset)

const signIn = (token: string) =>
  fetchWorker('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })

describe('the page signs people in with a cookie', () => {
  it('gives a person an HttpOnly cookie for /api', async () => {
    const res = await signIn('sam-token')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^wt_session=sam-token; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)

    const me = await fetchWorker('/api/me', { headers: { cookie: 'wt_session=sam-token' } })
    expect(await me.json()).toMatchObject({ you: { id: 'sam', kind: 'person' } })
  })

  it("won't give an agent one", async () => {
    const res = await signIn('bot-token')
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
    // And an agent's token in a cookie doesn't count.
    expect((await fetchWorker('/api/me', { headers: { cookie: 'wt_session=bot-token' } })).status).toBe(401)
  })

  it('refuses a bad token', async () => {
    expect((await signIn('nope')).status).toBe(401)
  })

  it('only takes cookie changes as JSON from its own origin', async () => {
    const post = (headers: Record<string, string>) => fetchWorker('/api/actions/add_item', {
      method: 'POST', headers: { cookie: 'wt_session=sam-token', ...headers }, body: JSON.stringify({ title: 'A' }),
    })
    expect((await post({ 'content-type': 'application/json', origin: ORIGIN })).status).toBe(200)
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(401)
    expect((await post({ 'content-type': 'text/plain', origin: ORIGIN })).status).toBe(401)
  })

  it('signs out by clearing the cookie', async () => {
    const res = await fetchWorker('/api/session', { method: 'DELETE' })
    expect(res.headers.get('set-cookie')).toMatch(/^wt_session=; .*Max-Age=0/)
  })

  it('lists the actions for anyone signed in', async () => {
    const res = await fetchWorker('/api/actions', { headers: { authorization: 'Bearer bot-token' } })
    const { actions } = await res.json() as { actions: { name: string; agents: string }[] }
    expect(actions.find(a => a.name === 'close_item')?.agents).toBe('ask')
    expect(actions.find(a => a.name === 'decide_ask')?.agents).toBe('never')
  })
})

describe('token limits', () => {
  it('stops a token working once it has run out', async () => {
    await env.DB.prepare("INSERT INTO token_limits (id, expires_at) VALUES ('sam', '2000-01-01T00:00:00Z')").run()
    expect((await signIn('sam-token')).status).toBe(401)
    expect((await call('sam-token', 'list_work')).status).toBe(401)
    expect((await call('bot-token', 'list_work')).status).toBe(200)
  })

  it('keeps an agent to the actions its token lists, over the API and MCP', async () => {
    await env.DB.prepare(`INSERT INTO token_limits (id, expires_at, actions) VALUES ('triage-bot', '2999-01-01T00:00:00Z', '["list_work"]')`).run()
    expect((await call('bot-token', 'list_work')).status).toBe(200)
    const refused = await call('bot-token', 'add_item', { title: 'Something', why: 'Testing' })
    expect(refused).toMatchObject({ status: 403, body: { error: expect.stringMatching(/^Nothing changed: this token can't add_item/) } })
    const { body } = await rpc('bot-token', 'tools/list')
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_work'])
  })
})

describe('off switch', () => {
  it('answers every API and MCP call with what did not happen, until it is back on', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('off-switch', 'on')").run()
    expect(await call('sam-token', 'list_work')).toMatchObject({ status: 503, body: { error: expect.stringMatching(/^Switched off: nothing was done/) } })
    expect(await rpc('bot-token', 'tools/list')).toMatchObject({ status: 503, body: { error: { message: expect.stringMatching(/^Switched off/) } } })
    await env.DB.prepare("DELETE FROM settings WHERE key = 'off-switch'").run()
    expect((await call('sam-token', 'list_work')).status).toBe(200)
  })
})

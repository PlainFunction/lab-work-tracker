import { beforeEach, describe, expect, it } from 'vitest'
import { ORIGIN, fetchWorker, reset } from './helpers'

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

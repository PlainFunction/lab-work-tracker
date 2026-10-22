import { Module, Port, activeTelemetry, bindTelemetry, type Manifest, type Registry } from '#capabilities'
import { ACTIONS, perform, type Ctx, type Result } from './actions'
import type { Env } from './worker'

// The Worker is wired in a registry, like every lab: each port it builds runs
// in a span, and logs go to Loki tied to their trace.

export const VERSION = '0.1.0'

/** Every action, from the page, the API and MCP alike. A port, so each run is traced. */
export abstract class Actions extends Port {
  abstract perform(name: string, raw: unknown, ctx: Ctx): Promise<Result>
}

export class D1Actions extends Actions {
  async perform(name: string, raw: unknown, ctx: Ctx): Promise<Result> {
    // Only our own names: anything else could be anything.
    activeTelemetry()?.span?.setAttribute('pf.action', ACTIONS.some(a => a.name === name) ? name : 'unknown')
    activeTelemetry()?.span?.setAttribute('pf.actor.kind', ctx.actor.kind)
    // Awaited, not returned: a refusal would otherwise reject a promise the span
    // isn't holding yet, and workerd reports it as unhandled.
    return await perform(name, raw, ctx)
  }

  describe(): Manifest {
    return { name: 'Work tracker actions', use: 'Work items, comments and asks, for people and agents', personalInfo: ['name'], storesIn: 'Cloudflare D1' }
  }
}

export class TrackerModule extends Module {
  readonly #env: Env
  constructor(env: Env) {
    super()
    this.#env = env
  }

  register(c: Registry) {
    bindTelemetry(c, this.#env, { serviceName: 'pf-work-tracker', serviceVersion: VERSION, client: 'work-tracker' })
    c.bind(Actions, () => new D1Actions())
  }
}

# Lab 007: a work tracker for people and AI agents

The code behind our lab [We Gave AI Agents a To-Do List They Can't Tick Off](https://plainfunction.com.au/labs/work-tracker).
It covers the parts of a work tracker most teams use: a list of work, who has
it, where it's up to, and what happened to it.

The whole tracker is a list of twelve actions. The web page, the HTTP API and
an MCP server all run the same list, so a person and an AI agent can do the
same things, with two differences:

- **Agents give a why with every change.** It goes in the history people read.
- **Only people close work.** When an agent closes something, it becomes an
  ask on the page, and nothing changes until a person approves it. Approving
  runs exactly what was asked.

This repo is synced automatically from another source and doesn't take pull
requests.

```bash
npm install
npm test               # type-check, then the tests (in workerd, with real D1)
npm run db:local       # make the tables in a local D1
npm run token -- --name "Sam" --kind person        # prints a token, once
npm run token -- --name "Triage bot" --kind agent
npm run dev            # http://localhost:8787
```

## How it runs

```
Browser ──▶ static assets (index.html, app.js, app.css: about 5 KB gzipped, no framework)
        ──▶ /api/*  ──▶ Worker ──▶ D1
Agent   ──▶ /mcp    ──▶ Worker ──▶ D1
```

- `src/actions.ts`: every action, its input as a zod schema, and `perform()`,
  which holds the rules for agents. Read it first.
- `src/mcp.ts`: MCP over plain HTTP POST (JSON in, JSON out, no session). The
  tools are the actions.
- `src/worker.ts`: routing and sign-in. People sign in on the page with a
  token, which becomes an HttpOnly cookie. Agents send the token as a Bearer
  header. Only person tokens can become a cookie.
- `schema.sql`: actors, items, events (the history) and asks.
- `public/`: the page. It only calls `/api/actions/<name>`.

## The actions

| Action | Changes something | Agents |
|---|---|---|
| `list_work`, `get_item`, `list_asks`, `list_people`, `recent_activity` | No | Run |
| `add_item`, `edit_item`, `move_item`, `assign_item`, `comment` | Yes | Run, with a why |
| `close_item` | Yes | Becomes an ask |
| `decide_ask` | Yes | Refused |

`GET /api/actions` lists them with the JSON Schema of each input.

## Connecting an agent

Any MCP client that can send a header works. For Claude Code:

```bash
claude mcp add --transport http work https://work.example.com/mcp --header "Authorization: Bearer wt_..."
```

Or call the HTTP API directly:

```bash
curl https://work.example.com/api/actions/list_work \
  -H "Authorization: Bearer wt_..." -H "content-type: application/json" -d '{}'
```

## Deploying

```bash
npx wrangler d1 create work-tracker --location oc   # put the id in wrangler.toml
# uncomment routes in wrangler.toml with your host: workers.dev is off
npm run db:remote
npm run token -- --name "Sam" --kind person --remote
npm run deploy
```

Run `npm run token` again for the same name to replace a token, or
`npm run token -- --revoke <id> --remote` to stop one working. People and
agents are never deleted, so the history keeps their names.

A person's token works for a year and an agent's for 90 days; `--days` changes
that. `--actions` keeps an agent to the actions it needs, say
`--kind agent --actions list_work,get_item,comment`. Run `npm run db:remote` again after updating: it adds
the table for this and gives tokens from before it a year.

## Switching it off

`npm run off -- --remote` stops the tracker without a deploy: every API and MCP
call says nothing was done, for people and agents alike. Nothing is deleted, and
`npm run on -- --remote` starts it again.

## If a token leaks

Revoke it (`--revoke <id> --remote`) and give them a new one. There are no other
keys to rotate: D1 is a binding, not a key. If you can't tell
which token leaked, switch it off, replace them all, and switch it back on.

## License

MIT

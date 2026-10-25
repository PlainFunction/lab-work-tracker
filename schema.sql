-- Everyone who can use the tracker: people (the web page) and agents (MCP or
-- the HTTP API). Only a hash of each token is kept.
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- How long each token works and, for an agent, which actions it may run (a JSON list;
-- NULL is every action open to agents). An actor with no row here never runs out, so
-- applying this again gives any that are missing a year from now.
CREATE TABLE IF NOT EXISTS token_limits (
  id TEXT PRIMARY KEY REFERENCES actors(id),
  expires_at TEXT NOT NULL,
  actions TEXT
);
INSERT OR IGNORE INTO token_limits (id, expires_at) SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+365 days') FROM actors;

-- One piece of work. Nothing is ever deleted: work that won't happen is closed as dropped.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done', 'dropped')),
  owner TEXT REFERENCES actors(id),
  due TEXT,
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_status ON items (status, updated_at);

-- Every change, comment and decision, with who did it and why. Written in the
-- same batch as the change, so there's never one without the other.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id, id);

-- An agent asking a person to do something it isn't allowed to do itself.
-- The stored arguments are what run when a person approves.
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  action TEXT NOT NULL,
  args TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT NOT NULL,
  asked_by TEXT NOT NULL REFERENCES actors(id),
  asked_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'approved', 'declined')),
  decided_by TEXT REFERENCES actors(id),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS asks_state ON asks (state, id);

-- One switch that stops the tracker: while 'off-switch' is here, every API and MCP call
-- says nothing was done. npm run off -- --remote adds it; npm run on takes it away.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

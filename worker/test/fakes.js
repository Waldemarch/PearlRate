// Test doubles for the Cloudflare bindings the Worker uses.
//
// fakeD1(): the D1 API surface we use (prepare/bind/run/all/first) on top of a
// real in-memory SQLite (node:sqlite), so SQL, "no such table" errors,
// GROUP_CONCAT and integer division behave like D1 (which is SQLite).
// fakeKV(): Map-backed KV that counts puts (the free plan's scarce resource).
import { DatabaseSync } from "node:sqlite";

export function fakeD1({ failWith = null } = {}) {
  const db = new DatabaseSync(":memory:");
  const statements = [];
  return {
    statements, // every SQL text executed, in order
    sqlite: db,
    prepare(sql) {
      let params = [];
      const exec = (fn) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (failWith) return Promise.reject(new Error(failWith));
        try {
          return Promise.resolve(fn(db.prepare(sql)));
        } catch (e) {
          return Promise.reject(new Error("D1_ERROR: " + e.message + ": SQLITE_ERROR"));
        }
      };
      const stmt = {
        bind(...p) { params = p; return stmt; },
        run: () => exec((st) => ({ success: true, meta: { changes: st.run(...params).changes } })),
        all: () => exec((st) => ({ success: true, results: st.all(...params).map((r) => ({ ...r })) })),
        first: (col) => exec((st) => { const r = st.get(...params); return r ? (col ? r[col] : { ...r }) : null; }),
      };
      return stmt;
    },
    rows(table) {
      return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
    },
  };
}

export function fakeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  const kv = {
    puts: 0,
    reads: 0,
    map,
    async get(key) { kv.reads++; return map.has(key) ? map.get(key) : null; },
    async put(key, value) { kv.puts++; map.set(key, String(value)); },
    json(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
  };
  return kv;
}

// Replace global fetch with a router: (url, init) => body object | Response | Error.
export function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? url.startsWith(match) : match.test(url)) {
        const out = await handler(url, init);
        if (out instanceof Response) return out;
        if (out instanceof Error) throw out;
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ctx for scheduled(): collect waitUntil promises so the test can await them.
export function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), done: () => Promise.all(pending) };
}

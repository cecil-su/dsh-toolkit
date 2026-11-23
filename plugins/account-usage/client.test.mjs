import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real transport and state machine without rendering a mock UI.
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
function plugin(globals = {}) {
  let api;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(entry) {
    assert.equal(entry.id, '@local/account-usage');
    api = entry.factory(name => { assert.ok(['react', 'react-dom'].includes(name)); return {}; });
  } } }, Date, performance, AbortController, setTimeout, clearTimeout, ...globals });
  return api;
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const reading = (t = Date.now(), serverNow = t) => ({ status: 'ready', checkedAt: t, serverNow,
  week: { remainingPercent: 0, resetAt: t + 5_000 }, short: { remainingPercent: 100, resetAt: null } });
const plain = x => JSON.parse(JSON.stringify(x));

test('wire projection preserves missing windows, endpoints and no other fields', () => {
  const { decode, percent, due } = plugin();
  assert.deepEqual(plain(decode({ ...reading(1000), other: 'discard', short: null })),
    { status: 'ready', checkedAt: 1000, serverNow: 1000, transitMs: 0, short: null, week: { remainingPercent: 0, resetAt: 6000 } });
  for (const bad of [undefined, [], { status: 'ready', checkedAt: NaN },
    { ...reading(), week: { remainingPercent: '0' }, short: null }]) assert.equal(decode(bad).status, 'unavailable');
  assert.equal(decode({ status: 'signed-out' }).status, 'signed-out');
  for (const [v, expected] of [[0, '0%'], [100, '100%'], [0.02, '<0.1%'], [99.98, '>99.9%'], [12.5, '12.5%']]) {
    assert.equal(percent(v, 'en-US'), expected);
  }
  assert.equal(due({ resetAt: 100 }, 100), true);
  assert.equal(due({ resetAt: null }, 100), false);
});

test('dock meter shows remaining weekly quota only; zero and unavailable stay distinct', () => {
  const { meterValue } = plugin(), sample = reading(1_000);
  assert.equal(meterValue(sample, 1_000), 0);
  assert.equal(meterValue({ ...sample, week: sample.short }, 1_000), 100);
  assert.equal(meterValue(sample, 6_000), null);
  assert.equal(meterValue({ ...sample, week: null }, 1_000), null);
  for (const status of ['signed-out', 'loading', 'unavailable']) assert.equal(meterValue({ status }, 1_000), null);
});

test('compact badge uses the same 7d format in Chinese and English', () => {
  const { dockLabel } = plugin();
  for (const lang of ['zh-CN', 'en-US']) {
    assert.equal(dockLabel(71, lang), '7d 71%');
    assert.equal(dockLabel(0, lang), '7d 0%');
    assert.equal(dockLabel(null, lang), '7d —');
  }
});

test('popover follows the clicked button, flips only when necessary and stays inside the visible area', () => {
  const { panelPlacement: place } = plugin();
  const view = { left: 0, top: 0, width: 960, height: 720 };
  const at = (left, top) => ({ left, top, bottom: top + 22 });
  assert.deepEqual(plain(place(at(410, 660), 264, 196, view)), { left: 410, top: 456, maxHeight: 640 });
  assert.deepEqual(plain(place(at(870, 48), 264, 196, view)), { left: 684, top: 78, maxHeight: 630 });
  const small = { left: 50, top: 100, width: 320, height: 212 };
  assert.deepEqual(plain(place(at(88, 236), 264, 196, small)), { left: 88, top: 112, maxHeight: 116 });
  assert.deepEqual(plain(place(at(55, 128), 264, 196, small)), { left: 62, top: 158, maxHeight: 142 });
});

test('routes are fixed bodyless same-origin POSTs; logical-only shell fails closed', async () => {
  const calls = [], signal = new AbortController().signal;
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: () => reading(1000) }; };
  const { request } = plugin({ __DSH_TRANSPORT__: { fetch }, fetch: () => assert.fail('wrong carrier') });
  for (const force of [false, true]) assert.equal((await request(force, signal)).status, 'ready');
  assert.deepEqual(calls.map(x => x.url), ['api/account-usage/read', 'api/account-usage/refresh']);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST'); assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined); assert.equal(init.signal, signal);
  }
  const noFetch = plugin({ __DSH_TRANSPORT__: { rpc: {} }, fetch: () => assert.fail('not the authenticated shell') });
  assert.equal((await noFetch.request(false, signal)).status, 'unavailable');
});

test('the shipped Client can call the shipped Host registration with its wire shape', async () => {
  const routes = new Map();
  const host = await import('./index.js');
  host.apply({ credentials: { readRecord: () => undefined }, on() {}, effect(fn) { fn(); },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } } });
  const { request } = plugin({ fetch: async (name, init) => {
    const req = new Request('https://fixture.invalid/' + name, init);
    const route = routes.get(new URL(req.url).pathname);
    return route.fetch(req);
  } });
  for (const force of [false, true]) assert.deepEqual(plain(await request(force, new AbortController().signal)), { status: 'signed-out' });
});

test('a successful registered route supplies a separate Host clock on cache hits', async t => {
  const base = 1_800_000_000_000; let hostTime = base, upstreamCalls = 0;
  t.mock.method(Date, 'now', () => hostTime);
  t.mock.method(globalThis, 'fetch', async () => { upstreamCalls++; return Response.json({ rate_limit: {
    primary_window: { used_percent: 99.9, limit_window_seconds: 604800 },
    secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: base / 1000 + 3 },
  } }); });
  const claim = { exp: base / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } };
  const record = { kind: 'grant', payload: { type: 'oauth', expires: base + 3_600_000, accountId: 'fixture',
    access: `fixture.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.fixture` } };
  const routes = new Map(); let dispose;
  const host = await import('./index.js');
  host.apply({ credentials: { readRecord: () => record }, on() {}, effect(fn) { dispose = fn(); },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } } });
  const api = plugin({ fetch: (path, init) => routes.get('/' + path).fetch(new Request('https://fixture.invalid/' + path, init)) });
  const signal = new AbortController().signal;
  try {
    const first = await api.request(false, signal); assert.equal(first.status, 'ready');
    assert.equal(first.serverNow, base); assert.equal(first.checkedAt, base); assert.equal(api.dockLabel(first.week.remainingPercent, 'en'), '7d 0.1%');
    hostTime += 3500;
    const second = await api.request(false, signal); assert.equal(second.serverNow, hostTime); assert.equal(second.checkedAt, base);
    assert.equal(second.week.remainingPercent, 0.1); assert.equal(second.short, null);
    assert.equal(second.retryAt, base + 10_000); assert.equal(upstreamCalls, 1);
  } finally { dispose(); }
});

test('server time rather than browser wall time controls TTL, window resets and retry-after-cooldown', async () => {
  for (const skew of [-65_000, 65_000]) {
    const base = 1_800_000_000_000; let mono = 500, wall = base + skew, i = 0;
    const timers = new Map(), replies = [];
    const api = plugin({ Date: { now: () => wall }, performance: { now: () => mono },
      setTimeout: (fn, ms) => { timers.set(++i, { fn, ms }); return i; }, clearTimeout: id => timers.delete(id) });
    const store = api.createStore(() => new Promise(resolve => replies.push(resolve)), () => true, () => true);
    function fire(ms) { const [id, task] = [...timers].find(([, t]) => t.ms === ms) || [];
      assert.ok(task, `timer ${ms}`); timers.delete(id); mono += ms; wall -= 86_400_000; task.fn(); }
    const week = { remainingPercent: 77, resetAt: null };
    const pair = { ...reading(base), week, short: { remainingPercent: 10, resetAt: base + 3000 } };
    store.subscribe(() => {});
    try {
      await turn(); replies.shift()(api.decode(pair)); await turn();
      assert.equal(store.now(), base); assert.equal(api.meterValue(store.getSnapshot().data, store.now()), 77);
      fire(3001); await turn(); assert.ok(api.due(store.getSnapshot().data.short, store.now()));
      replies.shift()(api.decode({ ...pair, short: null, serverNow: base + 3001, retryAt: base + 10_000 })); await turn();
      assert.equal(store.getSnapshot().data.checkedAt, base); assert.equal(store.getSnapshot().data.week.remainingPercent, 77);
      fire(6999); await turn(); assert.equal(replies.length, 1);
      replies.shift()(api.decode({ ...pair, short: null, serverNow: base + 10_000 })); await turn();
      fire(50_000); await turn(); assert.equal(store.getSnapshot().data.status, 'loading');
      // Delayed old cache cannot appear fresh just because it arrived now.
      replies.shift()(api.decode({ ...pair, serverNow: base + 60_000 })); await turn();
      assert.equal(store.getSnapshot().data.status, 'unavailable');
    } finally { store.dispose(); assert.equal(timers.size, 0); }
  }
});

test('the return trip ages a cached response, but Host work before its timestamp does not', async () => {
  const api = plugin(); const observed = { ...reading(1_000, 60_900), hostWorkMs: 10_000 };
  for (const [elapsed, status] of [[10_010, 'ready'], [10_200, 'unavailable']]) {
    const store = api.createStore(() => api.decode(observed, elapsed), () => true, () => true);
    store.subscribe(() => {});
    try { await turn(); assert.equal(store.getSnapshot().data.status, status); }
    finally { store.dispose(); }
  }
});

test('sessions share one in-flight read; replacing identity discards even a late successful reply', async () => {
  const pending = [], store = plugin().createStore((manual, signal) =>
    new Promise(resolve => pending.push({ resolve, manual, signal })), () => true, () => true);
  const a = store.subscribe(() => {}), b = store.subscribe(() => {});
  try {
    store.refresh(); await turn(); assert.equal(pending.length, 1);
    store.invalidate(); assert.ok(pending[0].signal.aborted); await turn();
    pending[1].resolve({ status: 'signed-out' }); await turn();
    pending[0].resolve(reading()); await turn(); assert.equal(store.getSnapshot().data.status, 'signed-out');
    store.refresh(); await turn(); assert.equal(pending[2].manual, true);
    pending[2].resolve(reading()); await turn(); assert.equal(store.getSnapshot().data.status, 'ready');
    a(); assert.equal(store.getSnapshot().data.status, 'ready');
    b(); assert.equal(store.getSnapshot().data.status, 'loading');
  } finally { store.dispose(); }
});

test('visibility and generation loss drop the old account, stop all timers and defer network reads', async () => {
  let visible = false, online = true, count = 0;
  const store = plugin().createStore(() => { count++; return reading(); }, () => visible, () => online);
  const off = store.subscribe(() => {});
  try {
    await turn(); assert.equal(count, 0); assert.equal(store.canRefresh(), false);
    visible = true; store.invalidate(); await turn(); assert.equal(count, 1); assert.equal(store.canRefresh(), true);
    online = false; store.invalidate(); assert.equal(store.getSnapshot().data.status, 'unavailable'); assert.equal(store.canRefresh(), false);
    visible = false; online = true; store.invalidate(); await turn(); assert.equal(count, 1);
    visible = true; store.invalidate(); await turn(); assert.equal(count, 2);
    off(); store.refresh(); await turn(); assert.equal(count, 2);
  } finally { store.dispose(); }
});

test('the first reset or TTL triggers a new baseline; overdue responses and old timeouts cannot revive data', async () => {
  let now = 1_000_000, i = 0;
  const timers = new Map(), pending = [];
  const { createStore } = plugin({ performance: { now: () => now }, Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++i, { fn, ms }); return i; }, clearTimeout: id => timers.delete(id) });
  function fire(ms) { const entry = [...timers].find(([, v]) => v.ms === ms); assert.ok(entry, `missing ${ms} timer`);
    timers.delete(entry[0]); now += ms; entry[1].fn(); }
  const store = createStore(() => new Promise(resolve => pending.push(resolve)), () => true, () => true);
  store.subscribe(() => {});
  try {
    await turn(); pending.shift()(reading(now)); await turn();
    fire(5_001); await turn(); assert.equal(pending.length, 1);
    assert.ok(plugin().due(store.getSnapshot().data.week, now));
    fire(15_000); assert.equal(store.getSnapshot().data.status, 'unavailable');
    pending.shift()(reading(now)); await turn(); assert.equal(store.getSnapshot().data.status, 'unavailable');
    fire(60_000); await turn(); pending.shift()(reading(now - 60_001, now)); await turn();
    assert.equal(store.getSnapshot().data.status, 'unavailable');
  } finally { store.dispose(); assert.equal(timers.size, 0); }
});

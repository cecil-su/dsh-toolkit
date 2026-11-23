import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, runOnce } from './migration.mjs';
import { mockLedger } from '../mock-ledger.mjs';

const record = (title = '样例标题', kind = 'provider', provider = 'demo') => ({ title, source: { kind, provider } });
test('archive hook fails before touching any Host service', () => assert.throws(() => apply(), /Archive only/));
test('broad scan deduplicates, protects skipped sessions, rechecks live titles and continues after a failure', async () => {
  const rows = new Map(Object.entries({ a: record(), b: record('手工样例','user'), c: undefined,
    d: record('0201｜功能｜样例主题'), e: record(), f: record(), g: record(), h: record(),
    i: record('手工样例','unknown'), j: record('## TASK'), k: record('默认样例','fallback'), l: record() }));
  const ledger = mockLedger(), calls = [];
  const ctx = {
    workspaceRegistry: { archivedSessionIds: ['e'], list: () => [{ sessionIds: [...rows.keys()] }, { sessionIds: ['a','b'] }] },
    sessionQuery: { readTitle: async id => rows.get(id), inspectSession: async (id, read) => read({header:{origin:id === 'f' ? 'subagent' : 'test'}}) },
    sessionController: { resolveAgent: async id => {
      if (id === 'g') rows.set(id, record('并发改名','user'));
      if (id === 'l') ctx.workspaceRegistry.archivedSessionIds.push(id);
      return { agent: { session: { id } } };
    } },
    sessions: { flush: async () => {} },
    sessionTitle: { get: s => rows.get(s.id), refresh: async s => {
      calls.push(s.id);
      if (s.id === 'h') throw Error('synthetic failure');
      const t = record('0201｜功能｜样例果园','provider','steward-session-title');
      rows.set(s.id,t); return t;
    } }
  };
  await runOnce(ctx, ledger); await runOnce(ctx, ledger);
  assert.deepEqual(calls, ['a','h','k']);
  assert.deepEqual(ledger.rows[0], {total:12});
  assert.deepEqual(ledger.rows.filter(r=>r.id).map(r=>r.status), ['updated','manual','no-title','already','archived','subagent','manual','error','unknown','manual','updated','archived']);
  assert.deepEqual(ledger.rows.at(-1), {done:true});
});

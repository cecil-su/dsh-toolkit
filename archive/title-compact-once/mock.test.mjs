import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, runOnce } from './migration.mjs';
import { mockLedger } from '../mock-ledger.mjs';

const targets = ['甲', '乙', '丙'].map((x, i) => [`demo-${i}`, `0301｜探索｜合成练习${x}号花园浇水时间计划与用水估算`]);
const old = 'steward-session-title', fresh = 'steward-session-title-compact';
async function mock(scenario) {
  const calls = [], ledger = mockLedger();
  const entries = new Map(targets.map(([id, title]) => [id, {title, eventSeq:2, source:{kind:'provider', provider:old}}]));
  if (scenario === 'mixed') entries.get('demo-0').source = {kind:'user'};
  const ctx = { workspaceRegistry:{ archivedSessionIds:[] },
    sessionQuery:{ readTitle:async id => entries.get(id) },
    sessionController:{ resolveAgent:async id => {
      if (scenario === 'mixed' && id === 'demo-1') entries.set(id, {...entries.get(id), eventSeq:8});
      return {agent:{session:{id,header:{origin:'test'}}}};
    } },
    sessions:{flush:async () => {}},
    sessionTitle:{get:s => entries.get(s.id), refresh:async s => {
      calls.push(s.id);
      if (scenario === 'error') throw Error('synthetic failure');
      const next = { title:'0301｜探索｜' + (scenario === 'long' ? '花'.repeat(15) : '花期记录'), eventSeq:3,
        source:{kind:'provider',provider:scenario === 'wrong' ? old : fresh} };
      entries.set(s.id, scenario === 'manual-race' ? {...next, source:{kind:'user'}} : next);
      return next;
    }} };
  await runOnce(ctx, ledger, targets); await runOnce(ctx, ledger, targets);
  return { calls, states:ledger.rows.filter(r => r.id).map(r=>r.status), stopped:ledger.rows.at(-1).stopped };
}
const all = targets.map(([id])=>id);
test('archive hook fails before touching any Host service', () => assert.throws(() => apply(), /Archive only/));
test('only supplied exact targets; a claimed ledger prevents repeat', async()=>assert.deepEqual(await mock(),{calls:all,states:all.map(()=>'updated'),stopped:false}));
test('manual title and changed live revision are protected', async()=>assert.deepEqual(await mock('mixed'),{calls:['demo-2'],states:['manual','mismatch','updated'],stopped:false}));
test('in-flight manual change wins without retry', async()=>assert.deepEqual(await mock('manual-race'),{calls:all,states:all.map(()=>'manual-won'),stopped:false}));
for (const scenario of ['wrong','long','error']) test(`stop on ${scenario}`, async()=>assert.deepEqual(await mock(scenario),{calls:['demo-0'],states:[scenario==='error'?'error':'verify-failed','not-run','not-run'],stopped:true}));

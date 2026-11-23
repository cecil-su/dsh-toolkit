import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '@local/compaction-effort';

const base = { provider: 'openai-codex', purpose: 'compaction', model: 'codex-model-a', messages: [], signal: new AbortController().signal, maxTokens: 8000 };
function verify(input, change) {
  let handler, dispatched = 0, passes = 0, received;
  apply({ on(event, listener) { assert.equal(event, 'llm/stream'); handler = listener; } });
  const result = {};
  const runtime = { stream(o) {
    assert.ok(++passes <= 2);
    return handler.call(this, o, () => { dispatched++; received = o; return result; });
  } };
  assert.equal(runtime.stream(Object.freeze(input)), result);
  assert.equal(dispatched, 1);
  if (!change) return assert.equal(received, input);
  assert.notEqual(received, input);
  assert.deepEqual(received, { ...input, reasoningEffort: 'medium' });
  assert.equal(received.messages, input.messages);
  assert.equal(received.signal, input.signal);
}

test('all Codex models default to medium on compaction', () => {
  for (const model of ['codex-model-a', 'other-codex-model', 'future-id'])
    for (const delta of [{}, { reasoningEffort: 'off' }, { reasoningEffort: 'none' }])
      verify({ ...base, model, ...delta }, true);
});
test('explicit efforts pass through unchanged', () => {
  for (const reasoningEffort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    verify({ ...base, reasoningEffort }, false);
});
test('non-compaction calls and other providers pass through unchanged', () => {
  for (const delta of [{ purpose: 'agent-loop' }, { purpose: 'session-title' }, { purpose: undefined }, { provider: 'openai' }, { provider: 'custom-codex' }])
    for (const effort of [{}, { reasoningEffort: 'none' }]) verify({ ...base, ...delta, ...effort }, false);
});

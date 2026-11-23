// Archive module. It ships no real targets, Host binding, file I/O or installation entry.
export function apply() { throw new Error('Archive only; installation is disabled.'); }
const oldProvider = 'steward-session-title';
const newProvider = 'steward-session-title-compact';
const matches = (t, expected) => t?.source?.kind === 'provider' && t.source.provider === oldProvider && t.title === expected;
const value = t => t?.title ?? null;
function compact(title, expected) {
  const m = /^(\d{4})｜(?:功能|设计|修复|优化|发布|探索|文档|研究)｜([^｜\r\n]+)$/u.exec(title);
  return !!m && m[1] === expected.slice(0, 4) && m[2] === m[2].trim() &&
    [...m[2]].length <= 14 && [...title].length < [...expected].length;
}
async function refreshOne(ctx, id, expected) {
  const base = { id, before: expected };
  const skipped = t => ({ id, status: t?.source?.kind === 'user' ? 'manual' : 'mismatch', before: value(t), after: value(t) });
  const archived = () => ctx.workspaceRegistry.archivedSessionIds.includes(id);
  if (archived()) return { id, status: 'archived' };
  const observed = await ctx.sessionQuery.readTitle(id);
  if (!matches(observed, expected)) return skipped(observed);
  const r = await ctx.sessionController.resolveAgent(id);
  if (r.error) throw r.error;
  const s = r.agent.session;
  if (s.id !== id || s.header.origin === 'subagent' || archived()) return { id, status: 'out-of-scope' };
  const before = ctx.sessionTitle.get(s);
  if (!matches(before, expected) || before.eventSeq !== observed.eventSeq) return skipped(before);
  try {
    const accepted = await ctx.sessionTitle.refresh(s, AbortSignal.timeout(30000));
    await ctx.sessions.flush(s);
    const actual = await ctx.sessionQuery.readTitle(id);
    if (actual?.source?.kind === 'user') return { ...base, status: 'manual-won', after: value(actual) };
    const ok = actual?.source?.kind === 'provider' && actual.source.provider === newProvider &&
      actual.eventSeq > before.eventSeq && actual.eventSeq === accepted?.eventSeq &&
      actual.title === accepted?.title && compact(actual.title, expected);
    return { ...base, after: value(actual), provider: actual?.source?.provider, status: ok ? 'updated' : 'verify-failed' };
  } catch (error) {
    const actual = ctx.sessionTitle.get(s);
    return { ...base, after: value(actual), status: actual?.source?.kind === 'user' ? 'manual-won' : 'error', reason: String(error).slice(0, 300) };
  }
}
export async function runOnce(ctx, ledger, targets) {
  if (!ledger.claim()) return;
  await ledger.note({ scope: targets.map(([id]) => id), started: true });
  let stopped = false;
  for (const [id, expected] of targets) {
    if (stopped) { await ledger.note({ id, status: 'not-run' }); continue; }
    let row;
    try { row = await refreshOne(ctx, id, expected); }
    catch (error) { row = { id, status: 'error', reason: String(error).slice(0, 300) }; }
    await ledger.note(row);
    stopped = row.status === 'error' || row.status === 'verify-failed';
  }
  await ledger.note({ finished: true, stopped });
}

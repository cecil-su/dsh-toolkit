// Archive module, not a DSH bundle. Importing does not touch the filesystem or Host.
export function apply() { throw new Error('Archive only; installation is disabled.'); }
const provider = 'steward-session-title';
const formatted = /^\d{4}｜(?:功能|设计|修复|优化|发布|探索|文档|研究)｜\S/u;
function skip(t) {
  if (!t) return 'no-title';
  if (t.source?.kind === 'user' || /^##\s*TASK$/iu.test(t.title.trim())) return 'manual';
  if (!['provider', 'fallback'].includes(t.source?.kind)) return 'unknown';
  if (t.source.provider === provider || formatted.test(t.title)) return 'already';
}

// The caller supplies all services and a one-shot ledger. There is no default
// connection, receipt path, agent lookup or auto-run on module load.
export async function runOnce(ctx, ledger) {
  if (!ledger.claim()) return;
  const ids = [...new Set(ctx.workspaceRegistry.list().flatMap(w => w.sessionIds))];
  const archived = id => ctx.workspaceRegistry.archivedSessionIds.includes(id);
  await ledger.note({ total: ids.length });
  for (const id of ids) {
    try {
      if (archived(id)) { await ledger.note({ id, status: 'archived' }); continue; }
      let why = skip(await ctx.sessionQuery.readTitle(id));
      if (why) { await ledger.note({ id, status: why }); continue; }
      const header = await ctx.sessionQuery.inspectSession(id, s => s.header);
      if (header.origin === 'subagent') { await ledger.note({ id, status: 'subagent' }); continue; }
      const r = await ctx.sessionController.resolveAgent(id);
      if (r.error) throw r.error;
      const s = r.agent.session;
      const before = ctx.sessionTitle.get(s);
      why = skip(before);
      if (why || archived(id)) { await ledger.note({ id, status: why || 'archived' }); continue; }
      const accepted = await ctx.sessionTitle.refresh(s, AbortSignal.timeout(30000));
      await ctx.sessions.flush(s);
      const check = await ctx.sessionQuery.readTitle(id);
      const status = check?.source?.kind === 'user' ? 'manual' :
        accepted?.source?.provider === provider && check?.title === accepted.title ? 'updated' : 'unverified';
      await ledger.note({ id, status, before: before.title, after: check?.title });
    } catch (error) {
      await ledger.note({ id, status: 'error', reason: String(error).slice(0, 500) });
    }
  }
  await ledger.note({ done: true });
}

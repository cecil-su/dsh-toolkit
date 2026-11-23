export const name = 'compaction-effort';
export const inject = ['llm'];

export function compactionEffort(options, next) {
  if (options.purpose !== 'compaction' || options.provider !== 'openai-codex' ||
      ![undefined, 'off', 'none'].includes(options.reasoningEffort)) return next();

  // The copy has an explicit effort: its next waterfall visit passes straight through.
  return this.stream({ ...options, reasoningEffort: 'medium' });
}

export function apply(ctx) {
  ctx.on('llm/stream', compactionEffort, { global: true, prepend: true });
}

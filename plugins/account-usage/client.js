window.__ModuleLoader__.load({
  id: '@local/account-usage',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const MINUTE = 60_000;
    const KEY = 'llm-pi-ai/openai-codex';
    const NS = 'accountUsage';
    const WAIT = { status: 'loading' };
    const UNAVAILABLE = { status: 'unavailable' };
    const copy = {
      zh: {
        week: '7 天窗口', short: '5 小时窗口', title: 'Codex 账号额度',
        heading: 'Codex 剩余额度', brief: '周剩余 {value}', missingWeek: '周额度暂无读数', dueWeek: '周额度待更新',
        loading: '正在查询', 'signed-out': '未登录', unavailable: '额度暂不可用',
        signInHint: '请在模型设置中登录 OpenAI Codex。', failureHint: '暂时无法读取账号额度，请稍后刷新。', offlineHint: '尚未连接到 DSH。恢复连接后会自动查询额度。',
        missing: '此窗口暂无有效读数', due: '已到重置时间，等待新读数', unknownReset: '重置时间未提供',
        balance: '剩余 {left} · 已用 {used}', reset: '{time} 重置（{left}后）',
        days: '{d}天 {h}小时', hours: '{h}小时 {m}分', minutes: '{m}分', soon: '不到 1 分钟',
        updated: '更新于 {time}', refresh: '刷新', refreshing: '正在刷新…',
      },
      en: {
        week: '7-day window', short: '5-hour window', title: 'Codex account limits',
        heading: 'Codex quota remaining', brief: 'Weekly: {value} left', missingWeek: 'No weekly reading', dueWeek: 'Weekly limit updating',
        loading: 'Checking limits', 'signed-out': 'Signed out', unavailable: 'Limits unavailable',
        signInHint: 'Sign in to OpenAI Codex in Model settings.', failureHint: 'Account limits could not be read. Try refreshing later.', offlineHint: 'Not connected to DSH. Limits will update after reconnection.',
        missing: 'No current reading for this window', due: 'Reset time reached; awaiting new figures', unknownReset: 'Reset time not reported',
        balance: '{left} left · {used} used', reset: 'Resets {time} (in {left})',
        days: '{d}d {h}h', hours: '{h}h {m}m', minutes: '{m} min', soon: 'less than 1 min',
        updated: 'Updated {time}', refresh: 'Refresh', refreshing: 'Refreshing…',
      },
    };

    const validTime = value => Number.isSafeInteger(value) && value > 0 && value < 8.64e15;
    function readWindow(value) {
      const percent = value?.remainingPercent;
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
      return { remainingPercent: percent, resetAt: validTime(value.resetAt) ? value.resetAt : null };
    }
    function decode(value, elapsed = 0) {
      if (value?.status === 'signed-out') return { status: 'signed-out' };
      if (!validTime(value?.serverNow)) return UNAVAILABLE;
      const retry = validTime(value.retryAt) ? { retryAt: value.retryAt } : {};
      if (value.status !== 'ready' && !(value.status === 'unavailable' && retry.retryAt)) return UNAVAILABLE;
      // Host processing precedes serverNow. Only unaccounted transit/parse time
      // can age the sample in flight; use an upper bound rather than extend TTL.
      const work = Number.isSafeInteger(value.hostWorkMs) && value.hostWorkMs >= 0 ? value.hostWorkMs : 0;
      const clock = { serverNow: value.serverNow, transitMs: Math.max(0, elapsed - work), ...retry };
      if (value.status !== 'ready') return { ...UNAVAILABLE, ...clock };
      if (!validTime(value.checkedAt) || value.checkedAt > value.serverNow) return UNAVAILABLE;
      const week = readWindow(value.week), short = readWindow(value.short);
      return week || short ? { status: 'ready', week, short, checkedAt: value.checkedAt, ...clock } : UNAVAILABLE;
    }
    function percent(value, locale) {
      const nf = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
      // Never round a non-endpoint reading into 'empty' or 'full'.
      if (value > 0 && value < 0.1) return '<' + nf.format(0.001);
      if (value < 100 && value > 99.9) return '>' + nf.format(0.999);
      return nf.format(value / 100);
    }
    function countdown(ms, t) {
      if (ms < MINUTE) return t('soon');
      const minutes = Math.floor(ms / MINUTE), hours = Math.floor(minutes / 60);
      if (hours >= 24) return t('days', { d: Math.floor(hours / 24), h: hours % 24 });
      if (hours) return t('hours', { h: hours, m: minutes % 60 });
      return t('minutes', { m: minutes });
    }
    function due(item, now) { return item?.resetAt != null && item.resetAt <= now; }

    // The shell transport (when supplied) owns authentication. Never construct an
    // external URL, look up a token, follow redirects, or forward an error body.
    async function request(manual, signal) {
      const transport = globalThis.__DSH_TRANSPORT__;
      if (transport?.rpc && !transport.fetch) return UNAVAILABLE;
      const send = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch;
      const start = performance.now();
      const response = await send(manual ? 'api/account-usage/refresh' : 'api/account-usage/read', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal,
      });
      return response.ok ? decode(await response.json(), performance.now() - start) : UNAVAILABLE;
    }

    // One snapshot per plugin instance, not per Session, and no persistent cache.
    // A revoked request cannot repopulate the view after hide/logout/reconnect.
    function createStore(fetchUsage, isVisible, connected) {
      const listeners = new Set();
      let snapshot = { data: WAIT, busy: false }, flight, timer, dead = false;
      let offset = 0;
      const hostNow = () => offset + performance.now();
      function publish(data, busy) {
        snapshot = { data, busy };
        for (const fn of listeners) fn();
      }
      function cancel() {
        clearTimeout(timer);
        const old = flight;
        flight = undefined;
        if (old) { clearTimeout(old.timeout); old.controller.abort(); }
      }
      function active() { return !dead && listeners.size > 0 && isVisible() && connected(); }
      function load(manual = false) {
        if (!active() || flight) return;
        clearTimeout(timer);
        const current = { controller: new AbortController() };
        flight = current;
        const old = snapshot.data;
        // A manual refresh can straddle the reset/TTL. Re-render at that
        // boundary even when its network reply has not arrived yet.
        function showPending() {
          if (flight !== current) return;
          const t = hostNow();
          const fresh = old.status === 'ready' && t < old.checkedAt + MINUTE;
          publish(old.status === 'ready' && !fresh ? WAIT : old, true);
          if (fresh) {
            const edges = [old.checkedAt + MINUTE, old.week?.resetAt, old.short?.resetAt].filter(v => v > t);
            timer = setTimeout(showPending, Math.min(...edges) - t);
          }
        }
        showPending();
        function settle(data) {
          if (current !== flight) return;
          clearTimeout(timer);
          clearTimeout(current.timeout);
          flight = undefined;
          if (validTime(data.serverNow)) offset = data.serverNow + (data.transitMs || 0) - performance.now();
          const t = hostNow();
          let delay = data.status === 'signed-out' ? 5 * MINUTE : MINUTE;
          if (validTime(data.retryAt)) delay = Math.max(1, data.retryAt - data.serverNow);
          if (data.status === 'ready') {
            const end = data.checkedAt + MINUTE;
            if (!validTime(data.serverNow) || t >= end) {
              // If return transit, not sampling, crossed the TTL, request the next baseline promptly.
              if (data.serverNow < end) delay = Math.min(delay, Math.max(250, end - data.serverNow));
              data = UNAVAILABLE;
            } else {
              delay = Math.min(delay, end - t);
              for (const w of [data.week, data.short]) {
                if (w?.resetAt != null) delay = Math.min(delay, w.resetAt > t ? w.resetAt - t + 1 : Math.max(250, w.resetAt - data.serverNow));
              }
            }
          }
          publish(data, false);
          if (active()) timer = setTimeout(() => load(), delay);
        }
        current.timeout = setTimeout(() => { current.controller.abort(); settle(UNAVAILABLE); }, 15_000);
        Promise.resolve().then(() => current.controller.signal.aborted ? UNAVAILABLE : fetchUsage(manual, current.controller.signal))
          .then(settle, () => settle(UNAVAILABLE));
      }
      function invalidate() {
        cancel();
        publish(connected() ? WAIT : UNAVAILABLE, false);
        load();
      }
      return {
        getSnapshot: () => snapshot, now: hostNow, canRefresh: active,
        subscribe(fn) {
          listeners.add(fn);
          if (listeners.size === 1) invalidate();
          return () => { listeners.delete(fn); if (!listeners.size) { cancel(); snapshot = { data: WAIT, busy: false }; } };
        },
        refresh: () => load(true), invalidate,
        dispose() { dead = true; listeners.clear(); cancel(); snapshot = { data: WAIT, busy: false }; },
      };
    }

    // Measure our own button; do not depend on implicit CSS anchors or on a
    // browser toggle event to make the contents visible.
    const meterCss = `
      .acu-trigger {display:inline-flex;align-items:center;flex:none;gap:6px;white-space:nowrap;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;cursor:pointer}
      .acu-trigger:hover,.acu-trigger[aria-expanded=true] {background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary)}
      .acu-trigger:focus-visible,.acu-panel button:focus-visible {outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      /* ContextMeter follows the slot in source order. Place only our own flex item after it. */
      .acu-trigger {order:1}
      [data-composer-dock]:has(.acu-trigger) {reading-flow:flex-visual}
      .acu-panel {--acu-width:min(264px,calc(100vw - 24px));box-sizing:border-box;position:fixed;inset:auto;margin:0;width:var(--acu-width);height:fit-content;max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;padding:12px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,none);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;z-index:1100}
      .acu-heading,.acu-line,.acu-footer {display:flex;justify-content:space-between;align-items:baseline;gap:8px}
      .acu-number {color:var(--dsw-alias-label-primary);font-weight:600}
      .acu-window {margin-top:8px}
      .acu-track {height:4px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-border-l1))}
      .acu-track i {display:block;height:100%;background:var(--dsw-alias-chart-messages,var(--dsw-alias-brand-primary))}
      .acu-window-short .acu-track i {background:var(--dsw-alias-chart-tools,var(--dsw-alias-brand-primary))}
      .acu-note,.acu-footer {font-size:12px;color:var(--dsw-alias-label-secondary)}
      .acu-note {margin-top:2px}
      .acu-footer {border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:5px;flex-wrap:wrap}
      .acu-footer button {cursor:pointer;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;padding:2px 4px}
      .acu-footer button:disabled {color:inherit;cursor:default}
    `;
    function panelPlacement(button, width, contentHeight, view) {
      const edge = 12, gap = 8;
      const above = Math.max(0, button.top - gap - view.top - edge);
      const below = Math.max(0, view.top + view.height - edge - button.bottom - gap);
      const up = above >= contentHeight || above >= below;
      const maxHeight = up ? above : below;
      const left = Math.max(view.left + edge, Math.min(button.left, view.left + view.width - edge - width));
      const top = up ? button.top - gap - Math.min(contentHeight, maxHeight) : button.bottom + gap;
      return { left, top, maxHeight };
    }
    function trackPanel(button, panel) {
      let frame, previous;
      function align() {
        const rect = button.getBoundingClientRect(), vv = window.visualViewport;
        const view = vv ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
          : { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
        // Only while open: the dock can move without resizing, e.g. if a side pane slides in.
        const width = Math.min(264, Math.max(1, view.width - 24));
        if (panel.style.width !== `${width}px`) panel.style.width = `${width}px`;
        const { left, top, maxHeight } = panelPlacement(rect, width, panel.scrollHeight, view);
        const key = `${left}/${top}/${maxHeight}`;
        if (previous !== key) {
          Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${maxHeight}px` });
          previous = key;
        }
        frame = requestAnimationFrame(align);
      }
      align();
      return () => cancelAnimationFrame(frame);
    }
    // Do not treat an exhausted window as missing, or an unknown one as empty.
    function meterValue(data, now) {
      return data.status === 'ready' && data.week && !due(data.week, now) ? data.week.remainingPercent : null;
    }
    function dockLabel(value, locale) {
      return `7d ${value == null ? '—' : percent(value, locale)}`;
    }
    function Usage({ store, t, locale }) {
      const { data, busy } = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const [open, setOpen] = React.useState(false);
      const buttonRef = React.useRef(null), panelRef = React.useRef(null);
      React.useLayoutEffect(() => {
        if (!open || !buttonRef.current || !panelRef.current) return;
        const button = buttonRef.current, panel = panelRef.current;
        const stop = trackPanel(button, panel);
        const doc = button.ownerDocument;
        const outside = e => {
          if (!button.contains(e.target) && !panel.contains(e.target)) setOpen(false);
        };
        const escape = e => {
          if (e.key !== 'Escape' || (!button.contains(e.target) && !panel.contains(e.target))) return;
          e.preventDefault(); e.stopPropagation(); setOpen(false); button.focus({ preventScroll: true });
        };
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('focusin', outside, true);
        doc.addEventListener('keydown', escape, true);
        panel.focus({ preventScroll: true });
        return () => {
          stop();
          doc.removeEventListener('pointerdown', outside, true);
          doc.removeEventListener('focusin', outside, true);
          doc.removeEventListener('keydown', escape, true);
        };
      }, [open]);
      const [, tick] = React.useState(0);
      // Only an open reading needs a countdown clock; ticking never fetches.
      React.useEffect(() => {
        if (!open || data.status !== 'ready') return;
        const id = setInterval(() => tick(n => n + 1), MINUTE);
        return () => clearInterval(id);
      }, [open, data]);
      const now = store.now();
      const brief = data.status !== 'ready' ? t(data.status) : !data.week ? t('missingWeek')
        : due(data.week, now) ? t('dueWeek') : t('brief', { value: percent(data.week.remainingPercent, locale) });
      function timestamp(ms) {
        return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(ms);
      }
      function row(name) {
        const item = data[name];
        const valid = !!item && !due(item, now);
        return h('div', { key: name, className: `acu-window acu-window-${name}` },
          h('div', { className: 'acu-line' }, h('span', null, t(name)),
            h('strong', { className: 'acu-number' }, valid ? percent(item.remainingPercent, locale) : '—')),
          valid && h('div', { className: 'acu-track', 'aria-hidden': true }, h('i', { style: { width: `${item.remainingPercent}%` } })),
          h('div', { className: 'acu-note' }, !item ? t('missing') : !valid ? t('due') : item.resetAt
            ? t('reset', { time: timestamp(item.resetAt), left: countdown(item.resetAt - now, t) }) : t('unknownReset')));
      }
      const value = meterValue(data, now);
      const label = `${t('title')} · ${brief}`;
      const canRefresh = store.canRefresh();
      const uid = React.useId();
      const panelId = `acu-panel-weekly-${uid}`;
      return h(React.Fragment, null,
        h('style', null, meterCss),
        h('button', { ref: buttonRef, id: `acu-trigger-weekly-${uid}`, className: 'acu-trigger', type: 'button', onClick: () => setOpen(wasOpen => !wasOpen), title: label,
          'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': panelId },
          h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true },
            h('circle', { cx: 7, cy: 7, r: 5.5, strokeWidth: 2, stroke: 'var(--dsw-alias-border-l2)', strokeDasharray: value == null ? '2 2' : undefined }),
            value > 0 && h('circle', { cx: 7, cy: 7, r: 5.5, pathLength: 100, strokeWidth: 2, stroke: 'currentColor',
              strokeDasharray: `${value} 100`, transform: 'rotate(-90 7 7)' })),
          dockLabel(value, locale)),
        open && createPortal(h('section', { ref: panelRef, className: 'acu-panel', id: panelId, tabIndex: -1, role: 'dialog', 'aria-label': t('title') },
          h('strong', { className: 'acu-number' }, t('heading')),
          data.status === 'ready' ? ['week', 'short'].map(row) : h('p', null,
            t(data.status === 'signed-out' ? 'signInHint' : data.status === 'unavailable' ? (canRefresh ? 'failureHint' : 'offlineHint') : 'loading')),
          h('div', { className: 'acu-footer' },
            h('span', { role: 'status', 'aria-atomic': true }, busy ? t('refreshing') : data.status === 'ready' ? t('updated', { time: timestamp(data.checkedAt) }) : t(data.status)),
            h('button', { type: 'button', disabled: busy || !canRefresh, onClick: store.refresh }, t('refresh')))), buttonRef.current.ownerDocument.body));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'connection'],
      createStore, decode, percent, due, request, meterValue, dockLabel, panelPlacement,
      apply(ctx) {
        const generation = ctx.connection.generation;
        const store = createStore(request, () => !document.hidden, () => !!generation.getSnapshot());
        ctx.effect(() => ctx.locale.register(NS, copy), 'account-usage: copy');
        ctx.effect(() => {
          document.addEventListener('visibilitychange', store.invalidate);
          const off = generation.subscribe(store.invalidate);
          return () => { document.removeEventListener('visibilitychange', store.invalidate); off(); store.dispose(); };
        }, 'account-usage: page lifetime');
        ctx.remote.$on('credentials/record-updated', key => { if (key === KEY) store.invalidate(); });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'codex-account-usage', order: 2, label: 'Codex · 7d', locale: NS,
        }, ({ t }) => h(Usage, { store, t, locale: ctx.locale.getSnapshot().active })));
      },
    };
  },
});

window.__ModuleLoader__.load({
  id: '@local/dsh-codex-signin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host route the browser tab opens; it answers a 302 to the provider. */
    const ROUTE = '/codex-signin';
    /** Locale namespace owned by this plugin. */
    const NS = 'codexSignin';
    /** Provider this card variant belongs to. */
    const PROVIDER = 'openai-codex';

    const LITERALS = {
      title: 'OpenAI Codex',
      badge: 'ChatGPT 订阅',
      description: '用 ChatGPT Plus / Pro 账号登录，不需要 API Key。授权在浏览器里完成，回到这里后模型选择器会出现 Codex 系列模型。',
      action: '用 ChatGPT 账号登录',
      reopen: '在新标签页打开',
      opened: '已在新标签页打开授权页，请在浏览器里完成登录。',
      blocked: '浏览器拦住了新标签页，请点「在新标签页打开」。',
      sameOrigin: '无法确定 Host 地址：请从 DSH 页面打开这个入口。',
    };

    const ZH = { ...LITERALS };
    const EN = {
      title: 'OpenAI Codex',
      badge: 'ChatGPT plan',
      description: 'Sign in with a ChatGPT Plus / Pro account instead of an API key. Authorization happens in the browser; the Codex models appear in the model picker afterwards.',
      action: 'Sign in with ChatGPT',
      reopen: 'Open in a new tab',
      opened: 'The authorization page is open in a new tab; finish signing in there.',
      blocked: 'The browser blocked the new tab; use "Open in a new tab".',
      sameOrigin: 'The Host address is unknown; open this entry from the DSH page.',
    };

    /**
     * Resolve the HTTP origin of the Host serving this page. A static Desktop
     * page reports it through the shell-owned transport; a Web page is served
     * from that origin itself.
     * @returns the origin without a trailing slash, or an empty string.
     */
    function hostOrigin() {
      const transport = globalThis.__DSH_TRANSPORT__;
      const streamBase = transport !== null && typeof transport === 'object'
        && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : '';
      if (streamBase !== '') return streamBase.replace(/\/+$/u, '');
      if (typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:')) {
        return location.origin;
      }
      return '';
    }

    /**
     * The URL a click opens, plus whether its Host origin could be resolved.
     * @returns the absolute or document-relative entry URL and its state.
     */
    function entryUrl() {
      const origin = hostOrigin();
      return { url: origin + ROUTE, resolved: origin !== '' };
    }

    /**
     * Translate one key, falling back to the shipped Chinese copy when the
     * locale service did not bind this namespace.
     * @param t - the slot-supplied translate function, if any.
     * @param key - copy key in {@link LITERALS}.
     * @returns the visible text.
     */
    function translate(t, key) {
      const fallback = LITERALS[key] ?? key;
      if (typeof t !== 'function') return fallback;
      let value;
      try {
        value = t(key);
      } catch {
        return fallback;
      }
      return typeof value === 'string' && value !== '' && value !== key ? value : fallback;
    }

    const buttonStyle = {
      appearance: 'none',
      flex: '0 0 auto',
      border: 'none',
      borderRadius: '8px',
      padding: '8px 14px',
      font: 'inherit',
      fontSize: '13px',
      fontWeight: 600,
      lineHeight: 1.3,
      cursor: 'pointer',
      color: '#ffffff',
      background: 'var(--dsw-alias-brand-primary)',
    };

    const linkStyle = {
      fontSize: '12px',
      color: 'var(--dsw-alias-brand-primary)',
      textDecoration: 'none',
    };

    /**
     * The one interaction both entry variants share.
     * @param props - slot props plus the compact flag.
     * @returns the sign-in control.
     */
    function SignIn(props) {
      const t = props.t;
      const compact = props.variant === 'card';
      const [status, setStatus] = React.useState('idle');
      const target = entryUrl();
      const tr = (key) => translate(t, key);

      const start = (event) => {
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        // Open during the click so the popup blocker sees a user gesture, then
        // point the blank tab at the Host route that starts the flow.
        let tab = null;
        try {
          tab = window.open('about:blank', '_blank');
        } catch {
          tab = null;
        }
        if (tab) {
          try {
            tab.opener = null;
          } catch {
            // A cross-origin about:blank still navigates; opener locking is best effort.
          }
          try {
            tab.location.replace(target.url);
            setStatus('opened');
            return;
          } catch {
            // Fall through to the direct attempt below.
          }
        }
        try {
          window.open(target.url, '_blank', 'noopener');
          setStatus('opened');
        } catch {
          setStatus('blocked');
        }
      };

      const hint = status === 'opened'
        ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' } }, tr('opened'))
        : status === 'blocked'
          ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, tr('blocked'))
          : target.resolved
            ? null
            : h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)' } }, tr('sameOrigin'));

      if (compact) {
        return h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
          },
        }, [
          h('div', { key: 'copy', style: { flex: '1 1 240px', minWidth: 0 } }, [
            h('div', {
              key: 'title',
              style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
            }, tr('title')),
            h('div', {
              key: 'desc',
              style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
            }, tr('description')),
          ]),
          h('button', { key: 'go', type: 'button', onClick: start, style: buttonStyle }, tr('action')),
        ]);
      }

      return h('section', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '16px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
          h('span', { key: 'title', style: { fontSize: '13px', fontWeight: 600 } }, tr('title')),
          h('span', {
            key: 'badge',
            style: {
              fontSize: '11px',
              lineHeight: 1.6,
              padding: '1px 8px',
              borderRadius: '999px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
            },
          }, tr('badge')),
        ]),
        h('p', {
          key: 'desc',
          style: { margin: 0, fontSize: '12.5px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
        }, tr('description')),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, [
          h('button', { key: 'go', type: 'button', onClick: start, style: buttonStyle }, tr('action')),
          h('a', { key: 'link', href: target.url, target: '_blank', rel: 'noreferrer', style: linkStyle }, tr('reopen')),
          hint === null ? null : h('span', { key: 'hint' }, hint),
        ]),
      ]);
    }

    /**
     * Models-page footer entry: the always-visible seat.
     * @param props - footer owner props (empty) plus the locale face.
     * @returns the sign-in panel.
     */
    function FooterEntry(props) {
      return h(SignIn, { t: props.t, variant: 'footer' });
    }

    /**
     * Provider-card extension: appears inside the OpenAI Codex card only.
     * @param props - the card's directory row, configured flags, and locale face.
     * @returns the compact sign-in row, or null for other providers.
     */
    function CardEntry(props) {
      if (props?.provider?.provider !== PROVIDER) return null;
      return h(SignIn, { t: props.t, variant: 'card' });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The seats first, so a copy-registration failure cannot hide the entry.
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'codex-signin',
          order: 20,
          locale: NS,
        }, FooterEntry));
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: 'llm-pi-ai',
          locale: NS,
        }, CardEntry));
        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', ZH);
          const disposeEn = ctx.locale.register(NS, 'en', EN);
          return () => {
            disposeEn();
            disposeZh();
          };
        }, 'codex-signin: copy');
      },
    };
  },
});

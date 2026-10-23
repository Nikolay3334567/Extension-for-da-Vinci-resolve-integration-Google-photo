// First-run screen: OAuth client setup (once) and Google sign-in.

import { el, clear } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { call } from './api.js';
import { toast } from './toast.js';

const GUIDE_URL = 'https://github.com/Nikolay3334567/Extension-for-da-Vinci-resolve-integration-Google-photo/blob/HEAD/docs/GOOGLE_SETUP.md';

/** Which Google services to request access to (applies at the next sign-in). */
export function sourcePicker() {
  const sources = new Set(state.settings.sources || ['photos', 'drive']);
  const box = (id, label) =>
    el(
      'label.check',
      el('input', {
        type: 'checkbox',
        checked: sources.has(id),
        on: {
          change: async (e) => {
            if (e.target.checked) sources.add(id);
            else sources.delete(id);
            if (!sources.size) {
              sources.add(id);
              e.target.checked = true;
              return;
            }
            state.settings = await call('settings:set', { sources: [...sources] });
          },
        },
      }),
      el('span', label),
    );
  return el('div.ob-sources', el('span.muted', `${t('ob.sources')}:`), box('photos', t('src.photos')), box('drive', t('src.drive')));
}

export class Onboarding {
  constructor(root) {
    this.root = root;
    this.editingClient = false;
  }

  show({ editClient = false } = {}) {
    this.editingClient = editClient;
    this.root.classList.add('open');
    this.render();
  }

  hide() {
    this.root.classList.remove('open');
    clear(this.root);
  }

  render() {
    if (!this.root.classList.contains('open')) return;
    const auth = state.auth;
    clear(this.root);
    const clientReady = auth.hasClient && !this.editingClient;

    const step1 = el('section.ob-step', { class: clientReady ? 'done' : 'active' }, el('h3', el('span.ob-num', clientReady ? el('span', { html: icon('check') }) : '1'), t('ob.step1')));
    if (clientReady) {
      step1.append(
        el(
          'div.ob-row',
          el('span.muted', `${t('ob.clientOk')}: ${String(auth.clientId || '').slice(0, 28)}…`),
          el('button.btn.small', { on: { click: () => { this.editingClient = true; this.render(); } } }, t('ob.changeClient')),
        ),
      );
    } else {
      const id = el('input', { type: 'text', placeholder: '1234-abc.apps.googleusercontent.com', spellcheck: false });
      const secret = el('input', { type: 'password', placeholder: 'GOCSPX-…', spellcheck: false });
      const save = async () => {
        try {
          state.auth = await call('auth:setClient', { config: { clientId: id.value.trim(), clientSecret: secret.value.trim() } });
          this.editingClient = false;
          this.render();
        } catch (err) {
          toast(err.message, { level: 'error' });
        }
      };
      step1.append(
        el('p', t('ob.step1Text')),
        el('ol.ob-list', el('li', t('ob.s1')), el('li', t('ob.s2')), el('li', t('ob.s3')), el('li', t('ob.s4'))),
        el(
          'div.ob-row',
          el('button.btn.primary', {
            on: {
              click: async () => {
                try {
                  state.auth = await call('auth:pickClientFile');
                  if (state.auth.hasClient) {
                    this.editingClient = false;
                    this.render();
                  }
                } catch (err) {
                  toast(err.message, { level: 'error' });
                }
              },
            },
          }, el('span', { html: icon('download') }), t('ob.loadJson')),
          el('button.btn.link', { on: { click: () => call('app:openExternal', { url: GUIDE_URL }) } }, el('span', { html: icon('external') }), t('ob.guide')),
        ),
        el('details.ob-manual', el('summary', t('ob.orPaste')), el('label.field', el('span', t('ob.clientId')), id), el('label.field', el('span', t('ob.clientSecret')), secret), el('button.btn', { on: { click: save } }, t('ob.save'))),
      );
      // Dropping the downloaded JSON file anywhere on this screen works too.
      this.root.ondragover = (e) => e.preventDefault();
      this.root.ondrop = async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        try {
          state.auth = await call('auth:setClient', { config: await file.text() });
          this.editingClient = false;
          this.render();
        } catch (err) {
          toast(err.message, { level: 'error' });
        }
      };
    }

    const step2 = el('section.ob-step', { class: clientReady ? 'active' : 'locked' }, el('h3', el('span.ob-num', '2'), t('ob.step2')));
    if (auth.lastError === 'expired') step2.append(el('p.ob-warn', t('ob.expired')));
    step2.append(el('p', t('ob.step2Text')));
    step2.append(sourcePicker());
    if (auth.signingIn) {
      step2.append(el('div.ob-row', el('span.spinner'), el('span', t('ob.signingIn')), el('button.btn.small', { on: { click: () => call('auth:cancelSignIn') } }, t('act.cancel'))));
    } else {
      step2.append(
        el('div.ob-row', el('button.btn.google', {
          disabled: !clientReady,
          on: {
            click: async () => {
              try {
                state.auth = await call('auth:signIn');
              } catch (err) {
                if (!/cancel/i.test(err.message)) toast(err.message, { level: 'error' });
              }
            },
          },
        }, el('span', { html: icon('google') }), t('ob.signIn'))),
      );
    }

    this.root.append(
      el(
        'div.ob-card',
        el('div.ob-hero', el('div.ob-logo', { html: icon('cloud') }), el('h1', t('ob.title')), el('p.muted', t('ob.subtitle'))),
        step1,
        step2,
      ),
    );
  }
}

// Turns raw Google / Resolve errors into actionable messages (most of them happen while the
// Google Cloud project is being set up for the first time).

import { t, lang } from './i18n.js';
import { toast } from './toast.js';
import { call } from './api.js';

const RULES = [
  {
    test: /has not been used in project|it is disabled|SERVICE_DISABLED|accessNotConfigured/i,
    ru: (m) => `${/drive/i.test(m) ? 'Google Drive API' : 'Google Photos Picker API'} не включён в вашем проекте Google Cloud. Откройте ссылку, нажмите «Enable» и повторите через минуту.`,
    en: (m) => `${/drive/i.test(m) ? 'Google Drive API' : 'Google Photos Picker API'} is not enabled in your Google Cloud project. Open the link, click “Enable” and retry in a minute.`,
    link: (m) => (m.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/) || [])[0],
  },
  {
    test: /access was denied|access_denied|hasn't given you access|has not completed the Google verification/i,
    ru: () => 'Google не пустил аккаунт. Добавьте свой Gmail в Test users: Google Auth Platform → Audience → Test users, затем войдите снова.',
    en: () => 'Google refused this account. Add your Gmail under Test users (Google Auth Platform → Audience → Test users) and sign in again.',
    link: () => 'https://console.cloud.google.com/auth/audience',
  },
  {
    test: /invalid_client|client was not found|unauthorized_client/i,
    ru: () => 'Google не узнал OAuth-клиент. Загрузите заново JSON типа «Desktop app» (Настройки → OAuth-клиент → Изменить).',
    en: () => 'Google did not recognise the OAuth client. Load the “Desktop app” JSON again (Settings → OAuth client → Change).',
  },
  {
    test: /insufficient (authentication )?scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i,
    ru: () => 'Не хватает разрешений. Войдите снова и отметьте все галочки доступа на экране Google.',
    en: () => 'Missing permissions. Sign in again and tick every access checkbox on Google’s consent screen.',
  },
  {
    test: /redirect_uri_mismatch/i,
    ru: () => 'Нужен OAuth-клиент типа «Desktop app» (не «Web application»). Создайте его в Google Cloud Console.',
    en: () => 'The OAuth client must be of type “Desktop app” (not “Web application”).',
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|Network timeout/i,
    ru: () => 'Нет связи с Google. Проверьте подключение к интернету.',
    en: () => 'Cannot reach Google. Check your internet connection.',
  },
];

export function explain(message) {
  const text = String(message || '');
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { text: (lang() === 'ru' ? rule.ru : rule.en)(text), link: rule.link ? rule.link(text) : null };
    }
  }
  return { text: t('toast.error', { message: text }), link: null };
}

export function showError(errOrMessage, opts = {}) {
  const message = errOrMessage && errOrMessage.message ? errOrMessage.message : errOrMessage;
  const { text, link } = explain(message);
  return toast(text, {
    level: 'error',
    timeout: link ? 15000 : opts.timeout || 9000,
    action: link ? { label: lang() === 'ru' ? 'Открыть' : 'Open', run: () => call('app:openExternal', { url: link }) } : null,
  });
}

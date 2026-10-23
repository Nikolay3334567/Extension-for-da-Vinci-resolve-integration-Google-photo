# Настройка доступа к Google (один раз, ~3–5 минут)

Cloud Pool работает напрямую с вашим аккаунтом Google — без посредников и чужих серверов.
Для этого Google требует, чтобы у приложения был собственный **OAuth-клиент**. Он бесплатный,
создаётся один раз и хранится только у вас.

> English version is below.

## 1. Создайте проект

1. Откройте <https://console.cloud.google.com/> и войдите в любой аккаунт Google
   (не обязательно тот, где лежат фото).
2. Вверху нажмите на выбор проекта → **New project** (Новый проект) → имя, например, `Cloud Pool` → **Create**.
3. Убедитесь, что новый проект выбран вверху страницы.

## 2. Включите два API

Откройте **APIs & Services → Library** (<https://console.cloud.google.com/apis/library>) и включите:

- **Google Photos Picker API** — выбор фото и видео из Google Фото;
- **Google Drive API** — просмотр Google Диска (можно не включать, если Диск не нужен).

Найдите API через поиск и нажмите **Enable**.

## 3. Экран согласия (Google Auth Platform)

1. Откройте **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) → **Get started**.
   В старом интерфейсе это раздел *APIs & Services → OAuth consent screen*.
2. **App name**: `Cloud Pool`, **User support email**: ваш email → Next.
3. **Audience**: выберите **External** → Next.
4. **Contact information**: ваш email → Next → согласитесь с правилами → **Create**.
5. Перейдите в **Audience → Test users → Add users** и добавьте email аккаунта Google,
   **где хранятся ваши фото** (можно несколько). Сохраните.

Добавлять scopes в разделе *Data Access* не обязательно — Cloud Pool сам запросит нужные права при входе.

## 4. Создайте OAuth-клиент

1. **Google Auth Platform → Clients → Create client**
   (или *APIs & Services → Credentials → Create credentials → OAuth client ID*).
2. **Application type**: **Desktop app**. Имя — любое, например `Cloud Pool Desktop`.
3. Нажмите **Create**, затем **Download JSON**. Получится файл вида `client_secret_1234…apps.googleusercontent.com.json`.

## 5. Подключите клиент к Cloud Pool

Любой из способов:

- в окне Cloud Pool нажмите **«Загрузить client_secret….json»** и выберите скачанный файл
  (можно просто перетащить файл в окно);
- или откройте «вставить вручную» и скопируйте **Client ID** и **Client secret**;
- или положите JSON в папку проекта рядом с установщиком **до установки** — он будет подхвачен автоматически.

Затем нажмите **«Войти через Google»**. Откроется браузер:

1. выберите аккаунт с вашими фото;
2. появится предупреждение **«Google hasn’t verified this app»** — это нормально, ведь приложение ваше.
   Нажмите **Continue** (Продолжить);
3. разрешите доступ к выбранным фото Google Фото и (если включён) к Google Диску;
4. вкладка покажет «Готово» — возвращайтесь в Resolve.

## Важно знать

### Вход «слетает» раз в 7 дней

Пока приложение в статусе **Testing**, Google выдаёт токены на 7 дней — потом Cloud Pool попросит войти снова
(один клик). Чтобы этого не было: **Google Auth Platform → Audience → Publish app → In production**.
Проходить проверку Google не нужно: для личного использования (до 100 пользователей) будет только экран
«приложение не проверено», который вы уже видели.

### Почему нельзя просто показать всю медиатеку Google Фото

С 31 марта 2025 года Google закрыл сторонним приложениям чтение всей медиатеки. Единственный официальный
способ — **Google Photos Picker**: окно самого Google Фото (с полным поиском по людям, местам, предметам и датам),
в котором вы отмечаете нужные элементы. Cloud Pool получает доступ ровно к ним и сохраняет их в своей медиатеке.
Ссылки на файлы, выданные Google, действуют ограниченное время, поэтому выбранные видео сразу начинают
скачиваться в фоне (это можно выключить в настройках).

### Какие права запрашиваются

| Право | Зачем |
|---|---|
| `photospicker.mediaitems.readonly` | доступ к фото и видео, которые вы выбрали в окне Google Фото |
| `drive.readonly` | просмотр и скачивание файлов Google Диска (только если включён источник «Google Диск») |
| `openid email profile` | показать, в какой аккаунт выполнен вход |

Токены хранятся в зашифрованном виде (Keychain на macOS, DPAPI на Windows) и передаются только серверам Google.

---

## English

1. <https://console.cloud.google.com/> → create a project.
2. **APIs & Services → Library**: enable **Google Photos Picker API** and **Google Drive API**.
3. **Google Auth Platform → Get started**: app name, support email, **Audience: External**, contact email → Create.
   Then **Audience → Test users → Add users**: the Google account(s) that hold your photos.
4. **Clients → Create client → Desktop app → Create → Download JSON**.
5. In Cloud Pool: **Load client_secret….json** (or drop the file onto the window) → **Sign in with Google**.
   The “Google hasn’t verified this app” screen is expected for your own app — click **Continue**.

Apps in **Testing** get 7-day refresh tokens; publish the app (**Audience → Publish app**) to stay signed in.
Since March 2025 Google only lets third-party apps access the items you select in the Google Photos **Picker**,
which is why Cloud Pool opens Google’s own picker (with the full Google Photos search) to add items.

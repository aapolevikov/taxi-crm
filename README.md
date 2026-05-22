# Taxi CRM — Uber Fleet API Integration

## Быстрый старт (5 минут)

### 1. Загрузка на Netlify

1. Зайдите на [app.netlify.com](https://app.netlify.com) → Sign up (бесплатно)
2. Нажмите **Add new site → Deploy manually**
3. Создайте папку со следующей структурой:
   ```
   my-crm/
   ├── index.html          ← переименуйте taxi_crm_v4.html
   ├── netlify.toml
   └── netlify/
       └── functions/
           └── uber-proxy.js
   ```
4. Перетащите папку `my-crm` на страницу Netlify

### 2. Переменные окружения

В Netlify → **Site configuration → Environment variables** добавьте:

| Key | Value |
|-----|-------|
| `UBER_CLIENT_ID` | Ваш Client ID |
| `UBER_CLIENT_SECRET` | Ваш Client Secret |
| `UBER_APP_ID` | Ваш Application ID |

⚠️ **Никогда не вставляйте ключи прямо в HTML файл!**

### 3. Настройка в CRM

1. Откройте ваш сайт (например `your-site.netlify.app`)
2. Перейдите **Settings → API Integration**
3. Заполните:
   - **Fleet ID** — найдите в Uber Fleet Dashboard → Settings
   - **Client ID** — из Uber Developer Console
   - **Client Secret** — из Uber Developer Console
   - **Proxy URL** → `https://your-site.netlify.app/.netlify/functions/uber-proxy`
4. Нажмите **Test Connection**
5. Если успешно → **Settings → Sync & Data → Синхронизировать сейчас**

### 4. Uber Fleet API — где взять Fleet ID

1. Зайдите на [fleet.uber.com](https://fleet.uber.com)
2. Settings → Organization → Organization ID — это ваш Fleet ID

### Что синхронизируется

| Данные | Эндпоинт Uber | Раздел CRM |
|--------|--------------|------------|
| Водители | GET /v1/fleet/drivers | Drivers |
| Машины | GET /v1/fleet/vehicles | Cars |
| Поездки | GET /v1/fleet/trips | Trips вкладка |
| Выплаты | GET /v1/fleet/payments/driver-payouts | Transactions |
| Онлайн статус | GET /v1/fleet/drivers/status | Online |

### Поддержка

Если что-то не работает — проверьте:
- Логи в Netlify → Functions → uber-proxy → Logs
- Статус эндпоинтов в CRM Settings → API Integration

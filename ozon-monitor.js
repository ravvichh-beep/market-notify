// Ozon Seller -> Telegram notifier (separate bot from the Yandex one)
// Polls FBS orders, returns and stock levels, diffs against local state,
// notifies on anything new. Config comes from process.env (GitHub Actions secrets)
// with a local .env fallback for manual runs.
//
// Runs as its own script with its own state file and its own Telegram bot token
// so Ozon notifications stay clearly separated from the Yandex ones.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ENV_PATH = path.join(DIR, '.env');
const STATE_PATH = path.join(DIR, 'ozon-state.json');

const LOW_STOCK_THRESHOLD = 3;
const OZON_BASE = 'https://api-seller.ozon.ru';

function loadEnv() {
  // Ozon API creds + a dedicated Telegram bot. Chat id is shared with the Yandex bot.
  const required = ['OZON_API_KEY', 'OZON_CLIENT_ID', 'TELEGRAM_OZON_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  for (const key of required) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function loadState() {
  const defaults = { orders: {}, returns: {}, lowStock: {}, firstRun: true };
  if (!fs.existsSync(STATE_PATH)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [ozon] ${msg}`);
}

async function ozonPost(pathName, env, body) {
  const res = await fetch(`${OZON_BASE}${pathName}`, {
    method: 'POST',
    headers: {
      'Client-Id': env.OZON_CLIENT_ID,
      'Api-Key': env.OZON_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathName} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_OZON_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const data = await res.json();
  if (!data.ok) log(`Telegram send failed: ${JSON.stringify(data)}`);
}

// Ozon FBS posting statuses -> Russian.
const STATUS_RU = {
  awaiting_registration: 'Ожидает регистрации',
  acceptance_in_progress: 'Идёт приёмка',
  awaiting_approve: 'Ожидает подтверждения',
  awaiting_packaging: 'Ожидает сборки',
  awaiting_deliver: 'Ожидает отгрузки',
  arbitration: 'Арбитраж',
  client_arbitration: 'Клиентский арбитраж',
  delivering: 'Доставляется',
  driver_pickup: 'У водителя',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  not_accepted: 'Не принят на сортировке',
  sent_by_seller: 'Отправлен продавцом',
};

function productsText(products) {
  return (products || [])
    .map(p => `  • ${(p.name || p.offer_id || '').slice(0, 40)} × ${p.quantity} — ${Math.round(parseFloat(p.price) || 0)}₽`)
    .join('\n');
}

async function checkOrders(env, state, notifications) {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const data = await ozonPost('/v3/posting/fbs/list', env, {
    dir: 'DESC',
    filter: { since, to },
    limit: 100,
    offset: 0,
    with: {},
  });
  const postings = (data.result && data.result.postings) || [];
  for (const p of postings) {
    const id = String(p.posting_number);
    const prevStatus = state.orders[id];
    if (prevStatus === undefined) {
      if (!state.firstRun) {
        const total = (p.products || []).reduce((s, x) => s + (parseFloat(x.price) || 0) * (x.quantity || 1), 0);
        notifications.push(
          `🛒 Новый заказ Ozon ${p.posting_number}\n` +
          `Статус: ${STATUS_RU[p.status] || p.status}\n` +
          `Сумма: ${Math.round(total)}₽\n` +
          `${productsText(p.products)}`
        );
      }
    } else if (prevStatus !== p.status) {
      if (!state.firstRun) {
        notifications.push(
          `📦 Заказ Ozon ${p.posting_number}: статус изменился\n` +
          `${STATUS_RU[prevStatus] || prevStatus} → ${STATUS_RU[p.status] || p.status}`
        );
      }
    }
    state.orders[id] = p.status;
  }
}

async function checkReturns(env, state, notifications) {
  const data = await ozonPost('/v1/returns/list', env, { filter: {}, limit: 100 });
  const returns = data.returns || [];
  for (const r of returns) {
    const id = String(r.id);
    if (state.returns[id] === undefined) {
      if (!state.firstRun) {
        notifications.push(
          `↩️ Возврат Ozon по заказу ${r.order_number || r.posting_number || '—'}\n` +
          `Тип: ${r.type || '—'}\n` +
          `Причина: ${r.return_reason_name || '—'}\n` +
          `Товар: ${(r.product && r.product.name ? r.product.name.slice(0, 40) : '—')}`
        );
      }
      state.returns[id] = true;
    }
  }
}

async function checkStock(env, state, notifications) {
  const data = await ozonPost('/v4/product/info/stocks', env, { filter: {}, limit: 100 });
  const items = data.items || [];
  for (const it of items) {
    const offerId = it.offer_id;
    const present = (it.stocks || []).reduce((s, x) => s + (x.present || 0), 0);
    const reserved = (it.stocks || []).reduce((s, x) => s + (x.reserved || 0), 0);
    const available = present - reserved;
    const wasLow = !!state.lowStock[offerId];
    const isLow = available <= LOW_STOCK_THRESHOLD;
    if (isLow && !wasLow && !state.firstRun) {
      notifications.push(
        `📉 Заканчивается товар на Ozon\n` +
        `${offerId}\n` +
        `Доступно: ${available} шт.`
      );
    }
    state.lowStock[offerId] = isLow;
  }
}

async function main() {
  const env = loadEnv();

  // Graceful no-op until the dedicated Ozon bot token is configured, so this
  // never breaks the shared workflow run before the bot is set up.
  const missing = ['OZON_API_KEY', 'OZON_CLIENT_ID', 'TELEGRAM_OZON_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(k => !env[k]);
  if (missing.length) {
    log(`Skipping Ozon check — config not set yet: ${missing.join(', ')}`);
    return;
  }

  const state = loadState();
  const notifications = [];

  const checks = [
    ['Orders', checkOrders],
    ['Returns', checkReturns],
    ['Stock', checkStock],
  ];

  for (const [name, fn] of checks) {
    try {
      await fn(env, state, notifications);
    } catch (e) {
      log(`${name} check failed: ${e.message}`);
    }
  }

  if (state.firstRun) {
    state.firstRun = false;
    log('First run: baseline saved, no notifications sent.');
  } else if (notifications.length === 0) {
    log('No changes.');
  } else {
    log(`Sending ${notifications.length} notification(s).`);
    for (const text of notifications) {
      await sendTelegram(env, text);
    }
  }

  saveState(state);
}

main().catch(e => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});

// Yandex Market -> Telegram notifier
// Polls recent orders + product feedback, diffs against local state, notifies on anything new.
// Config comes from process.env (GitHub Actions secrets) with a local .env fallback for manual runs.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ENV_PATH = path.join(DIR, '.env');
const STATE_PATH = path.join(DIR, 'state.json');

function loadEnv() {
  const required = [
    'YANDEX_API_KEY',
    'YANDEX_CAMPAIGN_ID',
    'YANDEX_BUSINESS_ID',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ];
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
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new Error(`Missing config: ${missing.join(', ')}`);
  return env;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { orders: {}, feedbacks: {}, firstRun: true };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function yandexGet(pathAndQuery, apiKey) {
  const res = await fetch(`https://api.partner.market.yandex.ru${pathAndQuery}`, {
    headers: { 'Api-Key': apiKey },
  });
  if (!res.ok) throw new Error(`GET ${pathAndQuery} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function yandexPost(pathAndQuery, apiKey, body) {
  const res = await fetch(`https://api.partner.market.yandex.ru${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathAndQuery} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const data = await res.json();
  if (!data.ok) log(`Telegram send failed: ${JSON.stringify(data)}`);
}

const STATUS_RU = {
  PROCESSING: 'В обработке',
  DELIVERY: 'Передан в доставку',
  PICKUP: 'Готов к самовывозу',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  UNPAID: 'Не оплачен',
  RESERVED: 'Зарезервирован',
};

async function checkOrders(env, state, notifications) {
  const data = await yandexGet(`/campaigns/${env.YANDEX_CAMPAIGN_ID}/orders?limit=50`, env.YANDEX_API_KEY);
  const orders = data.orders || [];
  for (const o of orders) {
    const id = String(o.id);
    const prevStatus = state.orders[id];
    if (prevStatus === undefined) {
      if (!state.firstRun) {
        const itemsText = (o.items || []).map(i => `  • ${i.offerName} × ${i.count} — ${i.price}₽`).join('\n');
        notifications.push(
          `🛒 Новый заказ #${o.id}\n` +
          `Статус: ${STATUS_RU[o.status] || o.status}\n` +
          `Сумма: ${o.buyerTotal}₽\n` +
          `${itemsText}`
        );
      }
    } else if (prevStatus !== o.status) {
      if (!state.firstRun) {
        notifications.push(
          `📦 Заказ #${o.id}: статус изменился\n` +
          `${STATUS_RU[prevStatus] || prevStatus} → ${STATUS_RU[o.status] || o.status}`
        );
      }
    }
    state.orders[id] = o.status;
  }
}

async function checkFeedback(env, state, notifications) {
  const data = await yandexPost(`/businesses/${env.YANDEX_BUSINESS_ID}/goods-feedback`, env.YANDEX_API_KEY, {
    limit: 50,
  });
  const feedbacks = (data.result && data.result.feedbacks) || [];
  for (const f of feedbacks) {
    const id = String(f.feedbackId);
    if (state.feedbacks[id] === undefined) {
      if (!state.firstRun) {
        const rating = f.rating != null ? `${f.rating}★` : '';
        const comment = (f.description && f.description.comment) || '';
        const shortComment = comment.length > 300 ? comment.slice(0, 300) + '…' : comment;
        notifications.push(
          `⭐ Новый отзыв ${rating}\n` +
          `${f.author || 'Аноним'}\n` +
          `${shortComment}`
        );
      }
    }
    state.feedbacks[id] = true;
  }
}

async function main() {
  const env = loadEnv();
  const state = loadState();
  const notifications = [];

  try {
    await checkOrders(env, state, notifications);
  } catch (e) {
    log(`Orders check failed: ${e.message}`);
  }

  try {
    await checkFeedback(env, state, notifications);
  } catch (e) {
    log(`Feedback check failed: ${e.message}`);
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

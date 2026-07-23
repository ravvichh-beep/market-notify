// Yandex Market -> Telegram notifier
// Polls orders, feedback, chats, returns and stock levels, diffs against local state,
// notifies on anything new. Config comes from process.env (GitHub Actions secrets)
// with a local .env fallback for manual runs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const ENV_PATH = path.join(DIR, '.env');
const STATE_PATH = path.join(DIR, 'state.json');

// State is committed to a public repo, so it is stored encrypted (AES-256-GCM).
// The key lives in the STATE_SECRET repo secret; without it the file is unreadable.
function stateKey() {
  const hex = process.env.STATE_SECRET || readEnvValue('STATE_SECRET');
  return hex ? Buffer.from(hex, 'hex') : null;
}

function readEnvValue(name) {
  if (!fs.existsSync(ENV_PATH)) return null;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[1] === name) return m[2].trim();
  }
  return null;
}

function encryptState(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ __enc: 'aes-256-gcm', iv: iv.toString('hex'), tag: tag.toString('hex'), data: data.toString('base64') });
}

function decryptState(raw, key) {
  const wrap = JSON.parse(raw);
  if (!wrap.__enc) return wrap; // plaintext (pre-encryption migration)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(wrap.tag, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(wrap.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

const LOW_STOCK_THRESHOLD = 3;
const UNANSWERED_REVIEW_HOURS = 24;

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
  const defaults = {
    orders: {},
    feedbacks: {},
    chats: {},
    returns: {},
    lowStock: {},
    firstRun: true,
  };
  if (!fs.existsSync(STATE_PATH)) return defaults;
  const raw = fs.readFileSync(STATE_PATH, 'utf8').trim();
  if (!raw) return defaults;
  const key = stateKey();
  const parsed = key ? decryptState(raw, key) : JSON.parse(raw);
  return { ...defaults, ...parsed };
}

function saveState(state) {
  const key = stateKey();
  fs.writeFileSync(STATE_PATH, key ? encryptState(state, key) : JSON.stringify(state, null, 2));
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

const RETURN_STATUS_RU = {
  READY_FOR_PICKUP: 'Готов к отгрузке',
  IN_TRANSIT: 'В пути',
  DELIVERED: 'Доставлен на склад',
  FINISHED: 'Обработан',
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
  const now = Date.now();

  for (const f of feedbacks) {
    const id = String(f.feedbackId);
    let entry = state.feedbacks[id];

    if (entry === undefined) {
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
      entry = { seen: true, reminded: false };
    }

    // Backward-compat: older state entries stored `true` instead of an object.
    if (entry === true) entry = { seen: true, reminded: false };

    const ageHours = (now - new Date(f.createdAt).getTime()) / 3600000;
    if (f.needReaction && !entry.reminded && ageHours >= UNANSWERED_REVIEW_HOURS) {
      if (!state.firstRun) {
        notifications.push(
          `⏰ Отзыв без ответа больше ${UNANSWERED_REVIEW_HOURS}ч\n` +
          `${f.author || 'Аноним'} (${f.rating != null ? f.rating + '★' : ''})\n` +
          `Ответь, чтобы не терять индекс качества.`
        );
      }
      entry.reminded = true;
    }
    if (!f.needReaction) entry.reminded = false;

    state.feedbacks[id] = entry;
  }
}

const CHAT_NEEDS_REPLY = new Set(['NEW', 'WAITING_FOR_PARTNER']);

async function checkChats(env, state, notifications) {
  const data = await yandexPost(`/businesses/${env.YANDEX_BUSINESS_ID}/chats?limit=20`, env.YANDEX_API_KEY, {});
  const chats = (data.result && data.result.chats) || [];

  for (const c of chats) {
    const id = String(c.chatId);
    const prevStatus = state.chats[id];
    const needsReply = CHAT_NEEDS_REPLY.has(c.status);

    if (needsReply && prevStatus !== c.status) {
      if (!state.firstRun) {
        let lastMessage = '';
        try {
          const history = await yandexPost(
            `/businesses/${env.YANDEX_BUSINESS_ID}/chats/history?chatId=${c.chatId}&limit=1`,
            env.YANDEX_API_KEY,
            {}
          );
          const msgs = (history.result && history.result.messages) || [];
          lastMessage = msgs.length ? msgs[msgs.length - 1].message : '';
        } catch (e) {
          log(`Chat history fetch failed for ${id}: ${e.message}`);
        }
        const shortMsg = lastMessage.length > 300 ? lastMessage.slice(0, 300) + '…' : lastMessage;
        notifications.push(
          `💬 Новое сообщение в чате (заказ #${c.orderId || '—'})\n` +
          `${c.context && c.context.customer && c.context.customer.name || 'Покупатель'}\n` +
          `${shortMsg}`
        );
      }
    }
    state.chats[id] = c.status;
  }
}

async function checkReturns(env, state, notifications) {
  const data = await yandexGet(`/campaigns/${env.YANDEX_CAMPAIGN_ID}/returns?limit=50`, env.YANDEX_API_KEY);
  const returns = (data.result && data.result.returns) || [];

  for (const r of returns) {
    const id = String(r.id);
    const prevStatus = state.returns[id];
    if (prevStatus === undefined) {
      if (!state.firstRun) {
        const typeLabel = r.returnType === 'UNREDEEMED' ? 'Невыкуп' : 'Возврат';
        notifications.push(
          `↩️ ${typeLabel} по заказу #${r.orderId}\n` +
          `Статус: ${RETURN_STATUS_RU[r.shipmentStatus] || r.shipmentStatus}\n` +
          `Сумма: ${r.amount ? r.amount.value + '₽' : '—'}`
        );
      }
    } else if (prevStatus !== r.shipmentStatus) {
      if (!state.firstRun) {
        notifications.push(
          `↩️ Возврат по заказу #${r.orderId}: статус изменился\n` +
          `${RETURN_STATUS_RU[prevStatus] || prevStatus} → ${RETURN_STATUS_RU[r.shipmentStatus] || r.shipmentStatus}`
        );
      }
    }
    state.returns[id] = r.shipmentStatus;
  }
}

async function checkStock(env, state, notifications) {
  const [stockData, mappingData] = await Promise.all([
    yandexPost(`/campaigns/${env.YANDEX_CAMPAIGN_ID}/offers/stocks`, env.YANDEX_API_KEY, {}),
    yandexPost(`/businesses/${env.YANDEX_BUSINESS_ID}/offer-mappings?limit=200`, env.YANDEX_API_KEY, {}),
  ]);

  const names = {};
  for (const m of (mappingData.result && mappingData.result.offerMappings) || []) {
    names[m.offer.offerId] = m.offer.name;
  }

  const warehouses = (stockData.result && stockData.result.warehouses) || [];
  const availableByOffer = {};
  for (const w of warehouses) {
    for (const o of w.offers || []) {
      const available = (o.stocks || []).find(s => s.type === 'AVAILABLE');
      const count = available ? available.count : 0;
      availableByOffer[o.offerId] = (availableByOffer[o.offerId] || 0) + count;
    }
  }

  for (const [offerId, count] of Object.entries(availableByOffer)) {
    const wasLow = !!state.lowStock[offerId];
    const isLow = count <= LOW_STOCK_THRESHOLD;
    if (isLow && !wasLow) {
      if (!state.firstRun) {
        const name = names[offerId] || offerId;
        notifications.push(
          `📉 Заканчивается товар\n` +
          `${name}\n` +
          `Остаток: ${count} шт.`
        );
      }
    }
    state.lowStock[offerId] = isLow;
  }
}

async function main() {
  const env = loadEnv();
  const state = loadState();
  const notifications = [];

  const checks = [
    ['Orders', checkOrders],
    ['Feedback', checkFeedback],
    ['Chats', checkChats],
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

// Telegram notifications — each account links its own Telegram chat, then gets the same notices as the dashboard bell.
// GET  /api/telegram                         (signed in) → { configured, linked, name, bot }
// POST /api/telegram { action: "link" }      (signed in) → { url }  — open it, press Start, the chat is linked
// POST /api/telegram { action: "unlink" | "test" }
// POST /api/telegram  (from Telegram, with the webhook secret header) → handles /start <code> and /stop
// Needs the TELEGRAM_BOT_TOKEN env var (a bot made with @BotFather). Without it everything here is switched off.
import crypto from 'node:crypto';
import { readJSON, writeJSON, userFromToken, bearer, parseBody, TELEGRAM, tgToken, tgSecret, tgCall, allAccounts } from './_lib.js';
import { attend, needsGeo } from './_attendance.js';
const LOCATE = (verb) => ({ keyboard: [[{ text: `📍 Share my location to ${verb}`, request_location: true }], [{ text: 'Cancel' }]], resize_keyboard: true, one_time_keyboard: true });
import { telegramReply } from './_messages.js';

// the buttons under the chat: check in / out and today's shift
const KEYBOARD = { keyboard: [[{ text: '✅ Check in' }, { text: '🏁 Check out' }], [{ text: '📅 My shift' }]], resize_keyboard: true, is_persistent: true };

const originOf = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

async function botName(tg) {
  if (tg.bot && tg.botToken === tgToken().slice(0, 12)) return tg.bot;
  const me = await tgCall('getMe', {}).catch((e) => { throw new Error(/unauthorized|not found/i.test(e.message) ? 'Telegram rejected the bot token — check TELEGRAM_BOT_TOKEN in Vercel (copy it again from @BotFather) and redeploy' : e.message); });
  tg.bot = me.username; tg.botToken = tgToken().slice(0, 12);
  return tg.bot;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // ---- updates from Telegram ----
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== undefined) {
      if (!tgToken() || secret !== tgSecret()) return res.status(401).json({ ok: false });
      const u = parseBody(req), m = u.message || u.edited_message;
      if (!m || !m.chat) return res.status(200).json({ ok: true });
      if (m.location) { // the answer to "share your location to check in / out"
        const tg = (await readJSON(TELEGRAM)) || {}; tg.links = tg.links || {}; tg.pending = tg.pending || {};
        const chatId = m.chat.id, username = Object.keys(tg.links).find((k) => tg.links[k].chatId === chatId);
        const account = username ? (await allAccounts()).find((a) => a.username === username) : null, p = tg.pending[chatId];
        let reply;
        if (!account) reply = 'To connect, open the dashboard → My account → Connect Telegram.';
        else if (m.forward_origin || m.forward_date) reply = 'Please send your current location with the button — forwarded locations don\'t count.';
        else if (!p || p.exp < Date.now()) reply = 'Tap ✅ Check in or 🏁 Check out first.';
        else {
          delete tg.pending[chatId]; await writeJSON(TELEGRAM, tg, 5);
          reply = (await attend(account, p.action, 'telegram', {}, `https://${req.headers['x-forwarded-host'] || req.headers.host}`, { lat: m.location.latitude, lng: m.location.longitude, acc: m.location.horizontal_accuracy || 0 })).msg;
        }
        await tgCall('sendMessage', { chat_id: chatId, text: reply, reply_markup: KEYBOARD }).catch(() => {});
        return res.status(200).json({ ok: true });
      }
      if (typeof m.text !== 'string') { await tgCall('sendMessage', { chat_id: m.chat.id, text: 'Only text messages reach the dashboard for now — please type your reply.' }).catch(() => {}); return res.status(200).json({ ok: true }); }
      const tg = (await readJSON(TELEGRAM)) || {}; tg.links = tg.links || {}; tg.codes = tg.codes || {};
      const text = m.text.trim(), chatId = m.chat.id;
      let reply;
      if (/^\/start\s+\w+/.test(text)) {
        const code = text.split(/\s+/)[1], c = tg.codes[code];
        if (c && c.exp > Date.now()) {
          for (const [k, v] of Object.entries(tg.links)) if (v.chatId === chatId && k !== c.username) delete tg.links[k]; // one dashboard account per chat
          tg.links[c.username] = { chatId, name: [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' '), at: new Date().toISOString() };
          delete tg.codes[code];
          await writeJSON(TELEGRAM, tg, 5);
          reply = `✅ Connected to the Vendoor Operations dashboard as <b>${String(c.name || c.username).replace(/[<>&]/g, '')}</b>.\n\n• Decisions on your schedule, records and tasks arrive here, with the reason.\n• Reply to any message to answer it — your reply reaches the dashboard.\n• Use the buttons below to check in and out of your shift.\n\nSend /stop to disconnect.`;
          await tgCall('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'HTML', reply_markup: KEYBOARD }).catch(() => {});
          return res.status(200).json({ ok: true });
        } else reply = 'This link has expired. Open the dashboard → My account → Connect Telegram, and try again.';
      } else if (/^\/stop/.test(text)) {
        let n = 0; for (const [k, v] of Object.entries(tg.links)) if (v.chatId === chatId) { delete tg.links[k]; n++; }
        if (n) await writeJSON(TELEGRAM, tg, 5);
        reply = n ? 'Disconnected. You won\'t get dashboard notifications here anymore.' : 'This chat isn\'t connected.';
      } else {
        // a linked chat: buttons / commands, otherwise the text is a reply to a dashboard message
        const username = Object.keys(tg.links).find((k) => tg.links[k].chatId === chatId);
        const account = username ? (await allAccounts()).find((a) => a.username === username) : null;
        const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
        if (!account) reply = 'To connect, open the dashboard → My account → Connect Telegram.';
        else if (/^(✅\s*)?check\s*in$|^\/in\b|^(🏁\s*)?check\s*out$|^\/out\b/i.test(text)) {
          const action = /in$|\/in\b/i.test(text) ? 'in' : 'out';
          if (await needsGeo(account, action)) { // office shift: ask for the location first
            tg.pending = tg.pending || {}; tg.pending[chatId] = { action, exp: Date.now() + 10 * 60e3 }; await writeJSON(TELEGRAM, tg, 5);
            await tgCall('sendMessage', { chat_id: chatId, text: `📍 This is an office shift — tap the button below to share your location and ${action === 'in' ? 'check in' : 'check out'}.`, reply_markup: LOCATE(action === 'in' ? 'check in' : 'check out') }).catch(() => {});
            return res.status(200).json({ ok: true });
          }
          reply = (await attend(account, action, 'telegram', {}, origin)).msg;
        }
        else if (/^cancel$/i.test(text)) { if (tg.pending && tg.pending[chatId]) { delete tg.pending[chatId]; await writeJSON(TELEGRAM, tg, 5); } reply = 'Cancelled.'; }
        else if (/^(📅\s*)?my\s*shift$|^\/shift\b/i.test(text)) reply = (await attend(account, 'status', 'telegram')).msg;
        else if (/^\/start\b/.test(text)) reply = 'You are connected ✅ Use the buttons below, or reply to any message.';
        else if (/^\//.test(text)) reply = 'Commands: /in · /out · /shift · /stop — or just write a message.';
        else reply = (await telegramReply(account, chatId, text, m.reply_to_message && m.reply_to_message.message_id, origin)).msg;
        await tgCall('sendMessage', { chat_id: chatId, text: reply, reply_markup: KEYBOARD, ...(m.message_id ? { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } } : {}) }).catch(() => {});
        return res.status(200).json({ ok: true });
      }
      await tgCall('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'HTML' }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    // ---- the dashboard ----
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    const tg = (await readJSON(TELEGRAM)) || {}; tg.links = tg.links || {}; tg.codes = tg.codes || {};
    const mine = tg.links[me.username];
    if (req.method === 'GET') {
      // make sure Telegram knows where to deliver messages, so the bot answers even a plain /start
      if (tgToken()) { const url = originOf(req) + '/api/telegram'; if (tg.hook !== url) { try { await botName(tg); await tgCall('setWebhook', { url, secret_token: tgSecret(), allowed_updates: ['message'] }); tg.hook = url; await writeJSON(TELEGRAM, tg, 5); } catch (e) { return res.status(200).json({ configured: true, linked: false, error: e.message }); } } }
      return res.status(200).json({ configured: !!tgToken(), linked: !!mine, name: mine ? mine.name : '', bot: tg.bot || '' });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    if (!tgToken()) return res.status(400).json({ error: 'Telegram isn\'t set up yet — add TELEGRAM_BOT_TOKEN in Vercel' });
    const { action } = parseBody(req);
    if (action === 'link') {
      const bot = await botName(tg), url = originOf(req) + '/api/telegram';
      if (tg.hook !== url) { await tgCall('setWebhook', { url, secret_token: tgSecret(), allowed_updates: ['message'] }); tg.hook = url; }
      for (const [k, c] of Object.entries(tg.codes)) if (c.exp < Date.now() || c.username === me.username) delete tg.codes[k];
      const code = crypto.randomBytes(9).toString('hex');
      tg.codes[code] = { username: me.username, name: me.name, exp: Date.now() + 15 * 60e3 };
      await writeJSON(TELEGRAM, tg, 5);
      return res.status(200).json({ url: `https://t.me/${bot}?start=${code}` });
    }
    if (action === 'unlink') {
      if (mine) { delete tg.links[me.username]; await writeJSON(TELEGRAM, tg, 5); await tgCall('sendMessage', { chat_id: mine.chatId, text: 'Disconnected from the Vendoor Operations dashboard.' }).catch(() => {}); }
      return res.status(200).json({ ok: true });
    }
    if (action === 'test') {
      if (!mine) return res.status(400).json({ error: 'Connect Telegram first' });
      await tgCall('sendMessage', { chat_id: mine.chatId, text: `🔔 Test from the Vendoor Operations dashboard — notifications for ${me.name} arrive here.` });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

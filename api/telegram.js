// Telegram notifications — each account links its own Telegram chat, then gets the same notices as the dashboard bell.
// GET  /api/telegram                         (signed in) → { configured, linked, name, bot }
// POST /api/telegram { action: "link" }      (signed in) → { url }  — open it, press Start, the chat is linked
// POST /api/telegram { action: "unlink" | "test" }
// POST /api/telegram  (from Telegram, with the webhook secret header) → handles /start <code> and /stop
// Needs the TELEGRAM_BOT_TOKEN env var (a bot made with @BotFather). Without it everything here is switched off.
import crypto from 'node:crypto';
import { readJSON, writeJSON, userFromToken, bearer, parseBody, TELEGRAM, tgToken, tgSecret, tgCall } from './_lib.js';

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
      if (!m || !m.chat || typeof m.text !== 'string') return res.status(200).json({ ok: true });
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
          reply = `✅ Connected to the Vendoor Operations dashboard as <b>${String(c.name || c.username).replace(/[<>&]/g, '')}</b>.\nYou'll get schedule approvals, rejections and submissions here.\nSend /stop to disconnect.`;
        } else reply = 'This link has expired. Open the dashboard → My account → Connect Telegram, and try again.';
      } else if (/^\/stop/.test(text)) {
        let n = 0; for (const [k, v] of Object.entries(tg.links)) if (v.chatId === chatId) { delete tg.links[k]; n++; }
        if (n) await writeJSON(TELEGRAM, tg, 5);
        reply = n ? 'Disconnected. You won\'t get dashboard notifications here anymore.' : 'This chat isn\'t connected.';
      } else reply = 'To connect, open the dashboard → My account → Connect Telegram.';
      await tgCall('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'HTML' }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    // ---- the dashboard ----
    const me = await userFromToken(bearer(req));
    if (!me) return res.status(401).json({ error: 'Please sign in again' });
    const tg = (await readJSON(TELEGRAM)) || {}; tg.links = tg.links || {}; tg.codes = tg.codes || {};
    const mine = tg.links[me.username];
    if (req.method === 'GET') return res.status(200).json({ configured: !!tgToken(), linked: !!mine, name: mine ? mine.name : '', bot: tg.bot || '' });
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

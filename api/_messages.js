// Direct messages between dashboard accounts, delivered to Telegram both ways.
// One conversation per pair of accounts ("alice|owner"). A message written in the dashboard goes to the other
// person's Telegram; their Telegram reply (to that message, or just the next text they send) comes back here
// and is forwarded to the first person's Telegram too.
import crypto from 'node:crypto';
import { readJSON, writeJSON, TELEGRAM, tgToken, tgCall, allAccounts, can } from './_lib.js';

export const MSGS = 'marketing-ops/messages';
const hx = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const pairKey = (a, b) => [a, b].sort().join('|');
const lead = (a) => a.owner || can(a, 'users') || can(a, 'approve');
// who an account may write to: managers write to anyone; the team writes to the owner and managers
export const contactsOf = (me, accounts) => accounts.filter((a) => a.username !== me.username && (lead(me) || lead(a)));

export async function sendMessage(me, to, text, via, origin) {
  text = String(text || '').trim().slice(0, 3000);
  if (!text) throw Object.assign(new Error('Write a message first'), { status: 400 });
  const accounts = await allAccounts(), ok = contactsOf(me, accounts), targets = [];
  for (const u of new Set(to)) { const a = ok.find((x) => x.username === u); if (a) targets.push(a); }
  if (!targets.length) throw Object.assign(new Error("You can't message that account"), { status: 403 });
  const doc = (await readJSON(MSGS)) || { threads: {} }, now = new Date().toISOString();
  doc.threads = doc.threads || {};
  const tg = tgToken() ? (await readJSON(TELEGRAM)) || {} : {}, links = tg.links || {};
  tg.msgMap = tg.msgMap || {};
  let tgDirty = false;
  const sent = [];
  for (const a of targets) {
    const k = pairKey(me.username, a.username);
    const th = (doc.threads[k] = doc.threads[k] || { id: k, users: [me.username, a.username].sort(), msgs: [], read: {} });
    const m = { id: crypto.randomBytes(5).toString('hex'), at: now, from: { username: me.username, name: me.name }, text, via };
    const l = links[a.username];
    if (l && tgToken()) {
      try {
        const r = await tgCall('sendMessage', { chat_id: l.chatId, text: `💬 <b>${hx(me.name)}</b>\n${hx(text)}`, parse_mode: 'HTML', disable_web_page_preview: true, ...(origin && /^https:/.test(origin) ? { reply_markup: { inline_keyboard: [[{ text: 'Open in the dashboard', url: `${origin}/#messages` }]] } } : {}) });
        m.tg = 'sent'; tg.msgMap[`${l.chatId}:${r.message_id}`] = k; tgDirty = true;
      } catch { m.tg = 'failed'; }
    }
    th.msgs.push(m); th.msgs = th.msgs.slice(-300);
    th.read[me.username] = now; th.last = now;
    sent.push({ to: a.username, thread: k, tg: m.tg || 'not linked' });
  }
  await writeJSON(MSGS, doc, 5);
  if (tgDirty) { const keys = Object.keys(tg.msgMap); if (keys.length > 800) for (const x of keys.slice(0, keys.length - 800)) delete tg.msgMap[x]; await writeJSON(TELEGRAM, tg, 5); }
  return sent;
}
// a Telegram text from a linked account: answer whoever wrote last (or the message they replied to)
export async function telegramReply(account, chatId, text, replyTo, origin) {
  const doc = (await readJSON(MSGS)) || { threads: {} }, tg = (await readJSON(TELEGRAM)) || {};
  let k = replyTo ? (tg.msgMap || {})[`${chatId}:${replyTo}`] : null;
  if (!k) {
    const mine = Object.values(doc.threads || {}).filter((t) => t.users.includes(account.username)).sort((a, b) => String(b.last).localeCompare(String(a.last)));
    const lastIn = mine.find((t) => t.msgs.some((m) => m.from.username !== account.username));
    k = (lastIn || mine[0] || {}).id || pairKey(account.username, 'owner');
  }
  const other = k.split('|').find((u) => u !== account.username) || 'owner';
  if (other === account.username) return { ok: false, msg: 'Nobody to send this to yet.' };
  const accounts = await allAccounts(), to = accounts.find((a) => a.username === other);
  await sendMessage(account, [other], text, 'telegram', origin);
  return { ok: true, msg: `✓ Sent to ${to ? to.name : other}` };
}

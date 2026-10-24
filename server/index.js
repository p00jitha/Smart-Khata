import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { scanNote, parseQuestion, parseSpoken, localize } from './ai.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const q = (text, params) => pool.query(text, params).then(r => r.rows);
const normPhone = p => String(p).replace(/\D/g, '').slice(-10);
const rs = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function auth(req, res, next) {
  try { req.shopId = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET).shopId; next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
const token = shop => jwt.sign({ shopId: shop.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

// ---------- auth ----------
app.post('/api/auth/register', wrap(async (req, res) => {
  const b = z.object({ shopName: z.string().min(2), email: z.string().email(), password: z.string().min(6) }).parse(req.body);
  const [shop] = await q('INSERT INTO shops(name,email,password_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,name',
    [b.shopName, b.email.toLowerCase(), await bcrypt.hash(b.password, 10)]);
  if (!shop) throw fail(409, 'That email is already registered.');
  res.json({ token: token(shop), shopName: shop.name });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const b = z.object({ email: z.string(), password: z.string() }).parse(req.body);
  const [shop] = await q('SELECT * FROM shops WHERE email=$1', [b.email.toLowerCase()]);
  if (!shop || !(await bcrypt.compare(b.password, shop.password_hash))) throw fail(401, 'Wrong email or password.');
  res.json({ token: token(shop), shopName: shop.name });
}));

// ---------- ledger helpers (balance is always computed from confirmed records) ----------
const BAL = `(COALESCE((SELECT SUM(total) FROM bills b WHERE b.customer_id=c.id AND b.shop_id=c.shop_id AND b.status='confirmed'),0)
 - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.customer_id=c.id AND p.shop_id=c.shop_id AND p.status='confirmed'),0))`;
async function getCustomer(shopId, id) {
  const [c] = await q(`SELECT c.id,c.name,c.phone,${BAL} AS balance FROM customers c WHERE c.id=$1 AND c.shop_id=$2`, [id, shopId]);
  if (!c) throw fail(404, 'Customer not found.');
  return c;
}

// ---------- customers ----------
app.get('/api/customers', auth, wrap(async (req, res) => {
  const term = req.query.phone ? String(req.query.phone).trim() : null;
  res.json(await q(`SELECT c.id,c.name,c.phone,${BAL} AS balance FROM customers c WHERE c.shop_id=$1
    AND ($2::text IS NULL OR c.phone LIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%') ORDER BY balance DESC, c.name`, [req.shopId, term]));
}));
app.post('/api/customers', auth, wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(1), phone: z.string() }).parse(req.body);
  const phone = normPhone(b.phone);
  if (phone.length !== 10) throw fail(400, 'Enter a 10-digit phone number.');
  const [c] = await q('INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [req.shopId, b.name.trim(), phone]);
  if (!c) throw fail(409, 'A customer with this phone number already exists.');
  res.json(await getCustomer(req.shopId, c.id));
}));
app.get('/api/customers/:id/ledger', auth, wrap(async (req, res) => {
  const customer = await getCustomer(req.shopId, +req.params.id);
  const bills = await q(`SELECT b.id,b.total,b.created_at,b.receipt_token,
    (SELECT json_agg(json_build_object('description',description,'quantity',quantity,'unit',unit,'lineTotal',line_total) ORDER BY id) FROM bill_items i WHERE i.bill_id=b.id) AS items
    FROM bills b WHERE b.customer_id=$1 AND b.shop_id=$2 ORDER BY b.created_at DESC`, [customer.id, req.shopId]);
  const payments = await q('SELECT id,amount,method,reference,created_at FROM payments WHERE customer_id=$1 AND shop_id=$2 ORDER BY created_at DESC', [customer.id, req.shopId]);
  res.json({ customer, bills, payments, publicUrl: process.env.PUBLIC_URL || '' });
}));

// ---------- bills ----------
const ItemsSchema = z.array(z.object({
  description: z.string().trim().min(1), quantity: z.coerce.number().positive(), unit: z.string().optional().default(''),
  lineTotal: z.coerce.number({ invalid_type_error: 'Enter a price' }).nonnegative(),
})).min(1, 'Add at least one item');
const totalOf = items => items.reduce((s, i) => s + Math.round(i.lineTotal * 100), 0) / 100;

app.post('/api/ai/scan-list', auth, upload.single('image'), wrap(async (req, res) => {
  if (!req.file || !/^image\//.test(req.file.mimetype)) throw fail(400, 'Upload a photo of the note.');
  res.json(await scanNote(req.file.buffer, req.file.mimetype));
}));

app.post('/api/ai/parse-voice', auth, wrap(async (req, res) => {
  const b = z.object({ transcript: z.string().trim().min(3).max(800), mode: z.enum(['bill', 'payment']).default('bill') }).parse(req.body);
  res.json(await parseSpoken(b.transcript, b.mode));
}));

app.post('/api/bills/preview', auth, wrap(async (req, res) => {
  const items = ItemsSchema.parse(req.body.items);
  res.json({ items, total: totalOf(items) });
}));
app.post('/api/bills', auth, wrap(async (req, res) => {
  const b = z.object({ customerId: z.coerce.number(), items: ItemsSchema, idempotencyKey: z.string().min(8),
    paidNow: z.coerce.number().nonnegative().optional().default(0), method: z.string().optional().default('cash') }).parse(req.body);
  const customer = await getCustomer(req.shopId, b.customerId);
  const total = totalOf(b.items);
  if (b.paidNow > total) throw fail(400, 'Amount paid now cannot exceed the bill total.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id,receipt_token FROM bills WHERE shop_id=$1 AND idempotency_key=$2', [req.shopId, b.idempotencyKey]);
    let bill = dup.rows[0];
    if (!bill) {
      bill = (await client.query('INSERT INTO bills(shop_id,customer_id,total,idempotency_key,receipt_token) VALUES($1,$2,$3,$4,$5) RETURNING id,receipt_token',
        [req.shopId, customer.id, total, b.idempotencyKey, crypto.randomBytes(16).toString('hex')])).rows[0];
      for (const i of b.items)
        await client.query('INSERT INTO bill_items(bill_id,description,quantity,unit,line_total) VALUES($1,$2,$3,$4,$5)', [bill.id, i.description, i.quantity, i.unit, i.lineTotal]);
      if (b.paidNow > 0)
        await client.query('INSERT INTO payments(shop_id,customer_id,bill_id,amount,method) VALUES($1,$2,$3,$4,$5)', [req.shopId, customer.id, bill.id, b.paidNow, b.method]);
    }
    await client.query('COMMIT');
    const updated = await getCustomer(req.shopId, customer.id);
    res.json({ billId: bill.id, total, receiptToken: bill.receipt_token, balance: updated.balance, customer: updated });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
app.get('/api/bills/:id', auth, wrap(async (req, res) => {
  const [bill] = await q('SELECT * FROM bills WHERE id=$1 AND shop_id=$2', [+req.params.id, req.shopId]);
  if (!bill) throw fail(404, 'Bill not found.');
  res.json({ ...bill, items: await q('SELECT description,quantity,unit,line_total FROM bill_items WHERE bill_id=$1 ORDER BY id', [bill.id]) });
}));

// ---------- payments ----------
app.post('/api/customers/:id/payments', auth, wrap(async (req, res) => {
  const b = z.object({ amount: z.coerce.number().positive(), method: z.string().default('cash'), reference: z.string().optional() }).parse(req.body);
  const customer = await getCustomer(req.shopId, +req.params.id);
  if (b.amount > Number(customer.balance)) throw fail(400, `Payment is more than the outstanding ${rs(customer.balance)}.`);
  await q('INSERT INTO payments(shop_id,customer_id,amount,method,reference) VALUES($1,$2,$3,$4,$5)', [req.shopId, customer.id, b.amount, b.method, b.reference || null]);
  res.json(await getCustomer(req.shopId, customer.id));
}));

// ---------- AI ledger assistant: Gemma picks an intent, the backend runs fixed safe queries ----------


// ---------- AI assistants: Gemma picks an intent, the backend runs fixed safe queries ----------
const fmtDate = d => new Date(d).toLocaleDateString('en-IN');
const SINCE = `created_at > now() - ($2::int||' days')::interval`;
const owingRows = shop => q(`SELECT * FROM (SELECT c.id,c.name,c.phone,${BAL} AS balance FROM customers c WHERE c.shop_id=$1) x WHERE balance>0 ORDER BY balance DESC`, [shop]);

app.get('/api/summary', auth, wrap(async (req, res) => {
  const [s] = await q(`SELECT (SELECT COUNT(*) FROM customers WHERE shop_id=$1)::int AS customers,
    COALESCE((SELECT SUM(total) FROM bills WHERE shop_id=$1 AND status='confirmed'),0) - COALESCE((SELECT SUM(amount) FROM payments WHERE shop_id=$1 AND status='confirmed'),0) AS to_collect,
    COALESCE((SELECT SUM(amount) FROM payments WHERE shop_id=$1 AND status='confirmed' AND created_at >= date_trunc('month', now())),0) AS received_month,
    (SELECT COUNT(*) FROM (SELECT ${BAL} AS bal FROM customers c WHERE c.shop_id=$1) x WHERE bal>0)::int AS owing`, [req.shopId]);
  res.json(s);
}));

async function shopAnswer(shop, p) {
  const days = p.days;
  const owing = () => owingRows(shop);
  switch (p.intent) {
    case 'customer_count': {
      const [s] = await q(`SELECT COUNT(*)::int AS n FROM customers WHERE shop_id=$1`, [shop]); const o = await owing();
      return `You have ${s.n} customer${s.n === 1 ? '' : 's'}. ${o.length} of them currently ${o.length === 1 ? 'owes' : 'owe'} you money.`;
    }
    case 'total_to_collect': {
      const o = await owing(); const t = o.reduce((a, r) => a + Number(r.balance), 0);
      return o.length ? `You still have ${rs(t)} to collect from ${o.length} customer${o.length === 1 ? '' : 's'}.` : 'Nobody owes you anything right now.';
    }
    case 'customers_owing': case 'top_debtors': {
      let o = await owing(); if (p.intent === 'top_debtors') o = o.slice(0, 5);
      return o.length ? (p.intent === 'top_debtors' ? 'Customers owing the most:\n' : 'Customers who owe you:\n') + o.map(r => `• ${r.name}: ${rs(r.balance)}`).join('\n') : 'Nobody owes you anything right now.';
    }
    case 'total_received': {
      const d = days || 30; const [r] = await q(`SELECT COALESCE(SUM(amount),0) AS t, COUNT(*)::int AS n FROM payments WHERE shop_id=$1 AND status='confirmed' AND ${SINCE}`, [shop, d]);
      return `You received ${rs(r.t)} in ${r.n} payment${r.n === 1 ? '' : 's'} over the last ${d} days.`;
    }
    case 'total_sales': {
      const d = days || 30; const [r] = await q(`SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM bills WHERE shop_id=$1 AND status='confirmed' AND ${SINCE}`, [shop, d]);
      return `You made ${r.n} bill${r.n === 1 ? '' : 's'} worth ${rs(r.t)} in the last ${d} days.`;
    }
    case 'inactive_customers': {
      const d = days || 30;
      const rows = await q(`SELECT * FROM (SELECT c.name,${BAL} AS balance,(SELECT MAX(created_at) FROM payments pp WHERE pp.customer_id=c.id AND pp.shop_id=c.shop_id AND pp.status='confirmed') AS last_paid
        FROM customers c WHERE c.shop_id=$1) x WHERE balance>0 AND (last_paid IS NULL OR last_paid < now() - ($2::int||' days')::interval) ORDER BY balance DESC`, [shop, d]);
      return rows.length ? `Customers with dues who haven't paid in ${d} days:\n` + rows.map(r => `• ${r.name}: ${rs(r.balance)} (${r.last_paid ? 'last paid ' + fmtDate(r.last_paid) : 'never paid'})`).join('\n') : `Every customer with dues has paid within the last ${d} days.`;
    }
    case 'shop_summary': {
      const [s] = await q(`SELECT (SELECT COUNT(*) FROM customers WHERE shop_id=$1)::int AS customers,
        COALESCE((SELECT SUM(amount) FROM payments WHERE shop_id=$1 AND status='confirmed' AND created_at >= date_trunc('month', now())),0) AS rec`, [shop]);
      const o = await owing(); const t = o.reduce((a, r) => a + Number(r.balance), 0);
      return `${s.customers} customers. ${rs(t)} to collect from ${o.length}. ${rs(s.rec)} received this month.${o[0] ? ` Highest due: ${o[0].name} (${rs(o[0].balance)}).` : ''}`;
    }
    default: return 'I can answer questions about all your customers: how many customers you have, total money to collect, who owes you the most, money received or billed in a period, and who has not paid recently.';
  }
}

async function customerAnswer(shop, c, p) {
  const days = p.days, name = c.name;
  switch (p.intent) {
    case 'customer_balance': return Number(c.balance) > 0 ? `${name} currently owes you ${rs(c.balance)}.` : `${name} has nothing outstanding.`;
    case 'customer_purchases': {
      const rows = await q(`SELECT b.created_at,i.description,i.quantity,i.unit,i.line_total FROM bills b JOIN bill_items i ON i.bill_id=b.id
        WHERE b.shop_id=$1 AND b.customer_id=$2 AND ($3::int IS NULL OR b.created_at > now() - ($3::int||' days')::interval) ORDER BY b.created_at DESC LIMIT 30`, [shop, c.id, days]);
      return rows.length ? `${name} bought:\n` + rows.map(r => `• ${r.description} ${Number(r.quantity)}${r.unit ? ' ' + r.unit : ''} — ${rs(r.line_total)} (${fmtDate(r.created_at)})`).join('\n')
        : `No purchases found for ${name}${days ? ` in the last ${days} days` : ''}.`;
    }
    case 'customer_total_spent': {
      const [r] = await q(`SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM bills WHERE shop_id=$1 AND customer_id=$2 AND status='confirmed' AND ($3::int IS NULL OR created_at > now() - ($3::int||' days')::interval)`, [shop, c.id, days]);
      return `${name} has bought ${rs(r.t)} worth of goods in ${r.n} bill${r.n === 1 ? '' : 's'}${days ? ` in the last ${days} days` : ' so far'}.`;
    }
    case 'customer_last_payment': {
      const [pay] = await q(`SELECT amount,method,created_at FROM payments WHERE shop_id=$1 AND customer_id=$2 AND status='confirmed' ORDER BY created_at DESC LIMIT 1`, [shop, c.id]);
      return pay ? `${name} last paid ${rs(pay.amount)} by ${pay.method} on ${fmtDate(pay.created_at)}.` : `${name} hasn't made any payment yet.`;
    }
    case 'customer_payments': {
      const rows = await q(`SELECT amount,method,created_at FROM payments WHERE shop_id=$1 AND customer_id=$2 AND status='confirmed' AND ($3::int IS NULL OR created_at > now() - ($3::int||' days')::interval) ORDER BY created_at DESC LIMIT 10`, [shop, c.id, days]);
      return rows.length ? `${name}'s payments:\n` + rows.map(r => `• ${rs(r.amount)} by ${r.method} on ${fmtDate(r.created_at)}`).join('\n') : `No payments recorded for ${name}${days ? ` in the last ${days} days` : ''}.`;
    }
    case 'customer_summary': {
      const [r] = await q(`SELECT COALESCE((SELECT SUM(total) FROM bills WHERE shop_id=$1 AND customer_id=$2),0) AS bought, COALESCE((SELECT SUM(amount) FROM payments WHERE shop_id=$1 AND customer_id=$2 AND status='confirmed'),0) AS paid,
        (SELECT MAX(created_at) FROM payments WHERE shop_id=$1 AND customer_id=$2 AND status='confirmed') AS last_paid`, [shop, c.id]);
      return `${name}: bought ${rs(r.bought)}, paid ${rs(r.paid)}, owes ${rs(c.balance)}. ${r.last_paid ? 'Last payment on ' + fmtDate(r.last_paid) + '.' : 'No payments yet.'}`;
    }
    default: return `I can answer questions about ${name}: balance, what they bought, total bought, last payment, payment history, or a summary.`;
  }
}

app.post('/api/ai/shop-chat', auth, wrap(async (req, res) => {
  const question = z.string().min(2).max(300).parse(req.body.question);
  const p = await parseQuestion(question, 'shop');
  res.json({ answer: await shopAnswer(req.shopId, p), viaAI: p.viaAI === true });
}));
app.post('/api/ai/customer-chat', auth, wrap(async (req, res) => {
  const b = z.object({ question: z.string().min(2).max(300), customerId: z.coerce.number() }).parse(req.body);
  const customer = await getCustomer(req.shopId, b.customerId); // enforces shop ownership
  const p = await parseQuestion(b.question, 'customer');
  res.json({ answer: await customerAnswer(req.shopId, customer, p), viaAI: p.viaAI === true });
}));

// ---------- Saved chats (history) ----------
async function ownChat(shop, id) {
  const [c] = await q('SELECT * FROM chats WHERE id=$1 AND shop_id=$2', [id, shop]);
  if (!c) throw fail(404, 'Chat not found.');
  return c;
}
app.get('/api/chats', auth, wrap(async (req, res) => {
  const cust = req.query.customerId ? await getCustomer(req.shopId, +req.query.customerId) : null;
  res.json(await q(`SELECT id,title,updated_at FROM chats WHERE shop_id=$1 AND customer_id IS NOT DISTINCT FROM $2::int ORDER BY updated_at DESC LIMIT 50`, [req.shopId, cust ? cust.id : null]));
}));
app.get('/api/chats/:id', auth, wrap(async (req, res) => {
  const chat = await ownChat(req.shopId, +req.params.id);
  const messages = await q('SELECT id,role,content,via_ai AS "viaAI",ms FROM chat_messages WHERE chat_id=$1 ORDER BY id', [chat.id]);
  res.json({ chat, messages });
}));
app.delete('/api/chats/:id', auth, wrap(async (req, res) => {
  const chat = await ownChat(req.shopId, +req.params.id);
  await q('DELETE FROM chats WHERE id=$1', [chat.id]);
  res.json({ ok: true });
}));
app.post('/api/chats/ask', auth, wrap(async (req, res) => {
  const b = z.object({ question: z.string().trim().min(2).max(300), chatId: z.coerce.number().nullish(), customerId: z.coerce.number().nullish(), lang: z.enum(['en', 'hi', 'te']).optional().default('en') }).parse(req.body);
  const customer = b.customerId ? await getCustomer(req.shopId, b.customerId) : null;
  let chat;
  if (b.chatId) {
    chat = await ownChat(req.shopId, b.chatId);
    if ((chat.customer_id || null) !== (customer ? customer.id : null)) throw fail(400, 'This chat belongs to a different view.');
  } else {
    [chat] = await q('INSERT INTO chats(shop_id,customer_id,title) VALUES($1,$2,$3) RETURNING *', [req.shopId, customer ? customer.id : null, b.question.slice(0, 60)]);
  }
  await q(`INSERT INTO chat_messages(chat_id,role,content) VALUES($1,'user',$2)`, [chat.id, b.question]);
  const t0 = Date.now();
  const p = await parseQuestion(b.question, customer ? 'customer' : 'shop');
  const english = customer ? await customerAnswer(req.shopId, customer, p) : await shopAnswer(req.shopId, p);
  const answer = await localize(english, b.lang);
  const ms = Date.now() - t0;
  await q(`INSERT INTO chat_messages(chat_id,role,content,via_ai,ms) VALUES($1,'assistant',$2,$3,$4)`, [chat.id, answer, p.viaAI === true, ms]);
  await q('UPDATE chats SET updated_at=now() WHERE id=$1', [chat.id]);
  res.json({ chatId: chat.id, title: chat.title, answer, viaAI: p.viaAI === true, ms });
}));

// ---------- public receipt (unguessable token) ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/r/:token', async (req, res) => {
  try {
    const [b] = await q(`SELECT b.id,b.total,b.created_at,s.name AS shop,c.name AS customer FROM bills b JOIN shops s ON s.id=b.shop_id JOIN customers c ON c.id=b.customer_id WHERE b.receipt_token=$1`, [req.params.token]);
    if (!b) return res.status(404).send('Receipt not found');
    const items = await q('SELECT description,quantity,unit,line_total FROM bill_items WHERE bill_id=$1 ORDER BY id', [b.id]);
    res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Receipt</title><body style="font-family:system-ui;max-width:420px;margin:24px auto;padding:0 16px">
<h2>${esc(b.shop)}</h2><p>Receipt #${b.id} · ${esc(b.customer)} · ${new Date(b.created_at).toLocaleDateString('en-IN')}</p>
<table width=100% cellpadding=6>${items.map(i => `<tr><td>${esc(i.description)} ${Number(i.quantity)}${esc(i.unit || '')}</td><td align=right>${rs(i.line_total)}</td></tr>`).join('')}
<tr><td><b>Total</b></td><td align=right><b>${rs(b.total)}</b></td></tr></table></body>`);
  } catch (e) { console.error(e); res.status(500).send('Error'); }
});

process.on('unhandledRejection', e => console.error('unhandled', e));

app.listen(process.env.PORT || 4000, () => console.log('Smart-Katha API on port ' + (process.env.PORT || 4000)));

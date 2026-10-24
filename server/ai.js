import { z } from 'zod';

const SCAN_MODEL = () => process.env.GEMMA_MODEL || 'gemma-4-31b-it';
const CHAT_MODEL = () => process.env.GEMMA_CHAT_MODEL || 'gemma-4-26b-a4b-it';
const BOTH = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// thinking: 'minimal' = thinking OFF (fast, 1-3 s). 'high' = thinking ON (slow, can take minutes).
async function callGemma(parts, { model, thinking = 'minimal', maxTokens = 1024 } = {}) {
  const models = [model, ...BOTH.filter(m => m !== model)];
  let useThinkingConfig = true, lastErr = new Error('unknown');
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 40000);
        const generationConfig = { maxOutputTokens: maxTokens, ...(useThinkingConfig ? { thinkingConfig: { thinkingLevel: thinking } } : {}) };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        }).finally(() => clearTimeout(timer));
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          if (text.trim()) return text;
          lastErr = new Error('empty response'); continue;
        }
        lastErr = new Error(`${m}: ${j.error?.message || r.status}`);
        console.error('Gemma error', r.status, lastErr.message);
        if (r.status === 400 && /think/i.test(j.error?.message || '') && useThinkingConfig) { useThinkingConfig = false; attempt--; continue; }
        if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
        await sleep(600);
      } catch (e) { lastErr = e; console.error('Gemma call failed:', e.message); }
    }
  }
  throw Object.assign(new Error('AI service error: ' + lastErr.message), { status: 502 });
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw Object.assign(new Error('AI returned no structured data. Enter the bill manually.'), { status: 502 });
  try { return JSON.parse(m[0]); } catch { throw Object.assign(new Error('AI returned invalid data. Enter the bill manually.'), { status: 502 }); }
}

const num = z.preprocess(v => (v === '' || v === undefined ? null : v), z.coerce.number().nonnegative().nullable());
const ScanSchema = z.object({
  customerName: z.string().nullable().optional(),
  items: z.array(z.object({
    description: z.string().min(1), quantity: num.optional(), unit: z.string().nullable().optional(),
    lineTotal: num.optional(), needsReview: z.boolean().optional(),
  })),
});

export async function scanNote(buffer, mimeType) {
  const prompt = `You read a shopkeeper's handwritten credit note (may be in English, Hindi, Telugu or mixed).
Return ONLY JSON: {"customerName": string|null, "items":[{"description":string,"quantity":number|null,"unit":string|null,"lineTotal":number|null,"needsReview":boolean}]}
Rules: lineTotal is the amount written for that line in rupees. If no price is written, use null - NEVER guess or invent prices.
Set needsReview=true for any unclear, crossed-out or uncertain entry. Do not include a grand total. No explanation.`;
  const text = await callGemma([{ text: prompt }, { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }],
    { model: SCAN_MODEL(), thinking: process.env.GEMMA_SCAN_THINKING || 'minimal', maxTokens: 2048 });
  const data = ScanSchema.parse(extractJson(text));
  return {
    customerName: data.customerName ?? null,
    items: data.items.map(i => ({
      description: i.description, quantity: i.quantity ?? 1, unit: i.unit ?? '',
      lineTotal: i.lineTotal ?? null, needsReview: !!i.needsReview || i.lineTotal == null,
    })),
  };
}

const SHOP_INTENTS = ['shop_summary', 'customer_count', 'total_to_collect', 'customers_owing', 'top_debtors', 'total_received', 'total_sales', 'inactive_customers', 'unknown'];
const CUST_INTENTS = ['customer_summary', 'customer_balance', 'customer_purchases', 'customer_total_spent', 'customer_last_payment', 'customer_payments', 'unknown'];
const QSchema = z.object({ intent: z.string(), days: z.coerce.number().int().positive().nullable().optional() });

const DESC = {
  shop_summary: 'overall overview of the shop', customer_count: 'how many customers', total_to_collect: 'total money still to be collected from all customers',
  customers_owing: 'list of customers who owe money', top_debtors: 'customers owing the most', total_received: 'money received from customers in a period',
  total_sales: 'total credit sales / bills made in a period', inactive_customers: 'customers who owe money but have not paid recently',
  customer_summary: 'overview of this customer', customer_balance: 'how much this customer owes', customer_purchases: 'items this customer bought',
  customer_total_spent: 'total value this customer has bought', customer_last_payment: 'when/how much this customer last paid', customer_payments: 'list of this customer\'s payments',
};

function windowDays(t) { return /week/.test(t) ? 7 : /month/.test(t) ? 30 : /today/.test(t) ? 1 : /year/.test(t) ? 365 : null; }
// Keyword fallback, used only if Gemma is unreachable, so the chat box never goes dead.
function keywordIntent(q, scope) {
  const t = q.toLowerCase(), days = windowDays(t); let intent = 'unknown';
  if (scope === 'shop') {
    if (/how many.*customer|number of customers|customer count/.test(t)) intent = 'customer_count';
    else if (/inactive|haven.?t paid|not paid|no payment/.test(t)) intent = 'inactive_customers';
    else if (/most|top|highest|biggest/.test(t)) intent = 'top_debtors';
    else if (/(who|which|list|show).*(owe|own|pending|due|unpaid)/.test(t)) intent = 'customers_owing';
    else if (/received|collected|came in/.test(t)) intent = 'total_received';
    else if (/sales|sold|billed/.test(t)) intent = 'total_sales';
    else if (/total|pending|collect|outstanding|owe|due/.test(t)) intent = 'total_to_collect';
    else if (/summary|overview|report/.test(t)) intent = 'shop_summary';
  } else {
    if (/last.*(paid|pay)|when.*(paid|pay)/.test(t)) intent = 'customer_last_payment';
    else if (/payments|payment history/.test(t)) intent = 'customer_payments';
    else if (/spent|total.*(bought|purchase)/.test(t)) intent = 'customer_total_spent';
    else if (/bought|purchase|buy|items/.test(t)) intent = 'customer_purchases';
    else if (/summary|overview/.test(t)) intent = 'customer_summary';
    else if (/owe|own|pay|due|balance|pending|outstanding/.test(t)) intent = 'customer_balance';
  }
  return { intent, days };
}

export async function parseQuestion(q, scope = 'shop') {
  const list = (scope === 'shop' ? SHOP_INTENTS : CUST_INTENTS).filter(i => i !== 'unknown');

  const prompt = `You classify a shopkeeper's question about their credit ledger (${scope === 'shop' ? 'the whole shop' : 'one specific customer'}).
The question may be written in English, Hindi, Telugu or a mix (Hinglish / Tenglish); understand it in any of them.
Return ONLY JSON like {"intent":"...","days":number|null}. No explanation.
Allowed intents:
${list.map(i => `- ${i}: ${DESC[i]}`).join('\n')}
- unknown: anything else
days = time window in days (today=1, last week=7, this month=30, this year=365) or null if none is mentioned.
Question: ${JSON.stringify(q)}`;
  try {
    const d = QSchema.parse(extractJson(await callGemma([{ text: prompt }], { model: CHAT_MODEL(), thinking: 'minimal', maxTokens: 80 })));
    if (![...list, 'unknown'].includes(d.intent)) throw new Error('bad intent ' + d.intent);
    return { intent: d.intent, days: d.days ?? null, viaAI: true };
  } catch (e) { console.error('Falling back to keyword intent:', e.message); return keywordIntent(q, scope); }
}


// ================= Voice entry + language support =================
const LANG_NAMES = { en: 'English', hi: 'Hindi', te: 'Telugu' };

const SpokenBillSchema = z.object({
  items: z.array(z.object({
    description: z.string().min(1), quantity: num.optional(), unit: z.string().nullable().optional(), lineTotal: num.optional(), needsReview: z.boolean().optional(),
  })).default([]),
  paidNow: num.optional(),
});
const SpokenPaySchema = z.object({ amount: num.optional(), method: z.string().nullable().optional() });

// Turns a spoken sentence (already converted to text by the browser) into structured data. The user still confirms it on screen.
export async function parseSpoken(transcript, mode = 'bill') {
  const rules = `The text was produced by speech-to-text, so it may contain small errors. It may be English, Hindi, Telugu or mixed.
Convert spoken numbers to digits (e.g. "sau"=100, "do sau"=200, "dedh sau"=150, "vanda"/"nooru"=100, "nuru"=100). Never guess a value that was not said: use null.`;
  if (mode === 'payment') {
    const prompt = `A shopkeeper in India dictated a payment received from a customer. ${rules}
Return ONLY JSON: {"amount": number|null, "method": "cash"|"upi"|null}. No explanation.
Text: ${JSON.stringify(transcript)}`;
    const d = SpokenPaySchema.parse(extractJson(await callGemma([{ text: prompt }], { model: CHAT_MODEL(), thinking: 'minimal', maxTokens: 120 })));
    const m = String(d.method || '').toLowerCase();
    return { amount: d.amount ?? null, method: m === 'cash' || m === 'upi' ? m : null };
  }
  const prompt = `A shopkeeper in India dictated a credit sale (goods given on credit). ${rules}
Return ONLY JSON: {"items":[{"description":string,"quantity":number|null,"unit":string|null,"lineTotal":number|null,"needsReview":boolean}],"paidNow":number|null}
Rules: description in English letters (transliterate Hindi/Telugu item names, e.g. "chawal" -> "Rice"). lineTotal = rupees for that line.
If the price of a line was not said, lineTotal = null and needsReview = true. paidNow = money the customer paid right now, only if said. No grand total. No explanation.
Text: ${JSON.stringify(transcript)}`;
  const d = SpokenBillSchema.parse(extractJson(await callGemma([{ text: prompt }], { model: CHAT_MODEL(), thinking: 'minimal', maxTokens: 700 })));
  return {
    items: d.items.map(i => ({
      description: i.description, quantity: i.quantity ?? 1, unit: i.unit ?? '',
      lineTotal: i.lineTotal ?? null, needsReview: !!i.needsReview || i.lineTotal == null,
    })),
    paidNow: d.paidNow ?? null,
  };
}

// Translates an answer that was built from real database numbers. Falls back to the English text if Gemma is unreachable.
export async function localize(text, lang) {
  if (!lang || lang === 'en' || !LANG_NAMES[lang]) return text;
  try {
    const prompt = `Translate this message from a shop ledger assistant into ${LANG_NAMES[lang]}.
Keep every number, the ₹ symbol, customer names, dates, bullet characters (•) and line breaks exactly as they are. Do not add or remove information. Return ONLY the translation.
Message:
${text}`;
    const out = await callGemma([{ text: prompt }], { model: CHAT_MODEL(), thinking: 'minimal', maxTokens: 700 });
    return out.trim() || text;
  } catch (e) { console.error('localize failed, sending English:', e.message); return text; }
}
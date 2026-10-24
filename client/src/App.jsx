import React, { useEffect, useRef, useState } from 'react';

const rs = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

async function api(path, { method = 'GET', body, form } = {}) {
  const t = localStorage.getItem('token');
  const r = await fetch('/api' + path, {
    method, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && t) { localStorage.removeItem('token'); location.reload(); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const Err = ({ msg }) => msg ? <div className="err" role="alert">{msg}</div> : null;
const Bal = ({ v }) => Number(v) > 0 ? <span className="badge due">⏳ {rs(v)} due</span> : <span className="badge clear">✓ Settled</span>;

function Auth({ onAuth }) {
  const [mode, setMode] = useState('login'), [f, setF] = useState({}), [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const go = async e => {
    e.preventDefault(); setErr('');
    try { const r = await api('/auth/' + mode, { method: 'POST', body: f }); localStorage.setItem('token', r.token); localStorage.setItem('shop', r.shopName); onAuth(); }
    catch (x) { setErr(x.message); }
  };
  return <div className="wrap" style={{ maxWidth: 420 }}>
    <h1>Smart-Katha</h1><p className="muted">Photograph a handwritten note. Check it. Save it to the ledger.</p>
    <form className="card" onSubmit={go}>
      <h2>{mode === 'login' ? 'Sign in' : 'Create your shop'}</h2><Err msg={err} />
      {mode === 'register' && <div className="row"><input aria-label="Shop name" placeholder="Shop name" onChange={set('shopName')} required /></div>}
      <div className="row"><input type="email" aria-label="Email" autoComplete="email" placeholder="Email" onChange={set('email')} required /></div>
      <div className="row"><input type="password" aria-label="Password" autoComplete="current-password" placeholder="Password (6+ characters)" onChange={set('password')} required /></div>
      <div className="row"><button className="ok">{mode === 'login' ? 'Sign in' : 'Create shop'}</button>
        <button type="button" className="ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'New shop? Register' : 'Have an account? Sign in'}</button></div>
    </form></div>;
}

const SHOP_CHIPS = ['How many customers do I have?', 'How much money is pending in total?', 'Who owes me the most?', 'How much did I receive this month?', 'Who has not paid in 30 days?'];
const custChips = n => [`How much does ${n} owe?`, `What did ${n} buy last week?`, `When did ${n} last pay?`, `Give me a summary of ${n}`];
const when = d => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// Right-hand assistant. Chats are saved on the server, so history survives reloads and new logins.
function ChatPanel({ customer, onClose }) {
  const cid = customer ? customer.id : null, qs = cid ? `?customerId=${cid}` : '';
  const [view, setView] = useState('chat'), [chatId, setChatId] = useState(null), [msgs, setMsgs] = useState([]), [history, setHistory] = useState([]);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const end = useRef(null);
  const loadHistory = () => api('/chats' + qs).then(setHistory).catch(() => {});
  useEffect(() => { loadHistory(); }, [cid]);
  useEffect(() => { end.current && end.current.scrollIntoView({ block: 'end' }); }, [msgs, busy, view]);
  const newChat = () => { setChatId(null); setMsgs([]); setErr(''); setText(''); setView('chat'); };
  const openChat = async id => {
    setErr('');
    try { const r = await api('/chats/' + id); setChatId(id); setMsgs(r.messages); setView('chat'); } catch (x) { setErr(x.message); }
  };
  const removeChat = async id => {
    if (!window.confirm('Delete this chat?')) return;
    try { await api('/chats/' + id, { method: 'DELETE' }); if (id === chatId) newChat(); loadHistory(); } catch (x) { setErr(x.message); }
  };
  const ask = async raw => {
    const question = raw.trim(); if (question.length < 2 || busy) return;
    setText(''); setErr(''); setBusy(true); setView('chat'); setMsgs(m => [...m, { role: 'user', content: question }]);
    try {
      const r = await api('/chats/ask', { method: 'POST', body: { question, chatId, customerId: cid } });
      setChatId(r.chatId); setMsgs(m => [...m, { role: 'assistant', content: r.answer, viaAI: r.viaAI, ms: r.ms }]); loadHistory();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const chips = customer ? custChips(customer.name) : SHOP_CHIPS;
  return <section className="chatbox" aria-label="Ledger assistant">
    <div className="chathead">
      <div><h2>Ledger assistant</h2><span className="ctxpill">{customer ? 'About ' + customer.name : 'All customers'}</span></div>
      <div className="chatbtns">
        <button className="ghost" onClick={newChat}>＋ New</button>
        <button className={view === 'history' ? 'ok' : 'ghost'} onClick={() => setView(view === 'history' ? 'chat' : 'history')} aria-pressed={view === 'history'}>History</button>
        <button className="ghost only-m" onClick={onClose} aria-label="Close assistant">✕</button></div></div>
    {view === 'history'
      ? <div className="chatbody" aria-label="Chat history">
          {history.length === 0 && <p className="muted">No saved chats yet. Ask a question to start one.</p>}
          {history.map(h => <div className={'hrow' + (h.id === chatId ? ' on' : '')} key={h.id}>
            <button className="hopen" onClick={() => openChat(h.id)}><span className="htitle">{h.title}</span><span className="muted">{when(h.updated_at)}</span></button>
            <button className="hdel" onClick={() => removeChat(h.id)} aria-label={'Delete chat: ' + h.title}>🗑</button></div>)}
          <div ref={end} /></div>
      : <div className="chatbody" role="log" aria-live="polite">
          {msgs.length === 0 && <div className="intro"><p><b>{customer ? `Ask anything about ${customer.name}.` : 'Ask anything about your shop.'}</b></p>
            <p className="muted">Answers come from your saved bills and payments. Try one:</p>
            <div className="chips">{chips.map(c => <button key={c} className="chip" disabled={busy} onClick={() => ask(c)}>{c}</button>)}</div></div>}
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={i} className="bubble user">{m.content}</div>
            : <div key={i} className="bubble bot">{m.content}
                {m.viaAI === true && <span className="meta">Gemma 4{m.ms != null ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}</span>}
                {m.viaAI === false && <span className="meta">Backup keyword matching (Gemma unavailable)</span>}</div>)}
          {busy && <div className="bubble bot muted">Thinking…</div>}
          {err && <div className="err" role="alert">{err}</div>}
          <div ref={end} /></div>}
    <form className="composer" onSubmit={e => { e.preventDefault(); ask(text); }}>
      <input aria-label="Your question" value={text} onChange={e => setText(e.target.value)} placeholder={customer ? `Ask about ${customer.name}…` : 'Ask about your shop…'} maxLength={300} />
      <button className="ok" disabled={busy || text.trim().length < 2}>Send</button></form>
  </section>;
}

function Home({ open }) {
  const [list, setList] = useState([]), [search, setSearch] = useState(''), [nw, setNw] = useState({ name: '', phone: '' }), [err, setErr] = useState(''), [sum, setSum] = useState(null);
  const load = s => api('/customers' + (s ? '?phone=' + encodeURIComponent(s) : '')).then(setList).catch(x => setErr(x.message));
  useEffect(() => { load(search); }, [search]);
  useEffect(() => { api('/summary').then(setSum).catch(() => {}); }, []);
  const add = async e => {
    e.preventDefault(); setErr('');
    try { const c = await api('/customers', { method: 'POST', body: nw }); open(c.id); } catch (x) { setErr(x.message); }
  };
  return <>
    <div className="pagehead"><h2>Dashboard</h2><p className="muted">Your customers, dues and payments at a glance.</p></div>
    {sum && <div className="stats">
      <div className="stat"><span className="muted">Customers</span><b>{sum.customers}</b></div>
      <div className="stat hot"><span className="muted">Money to collect · {sum.owing} customer{sum.owing === 1 ? '' : 's'}</span><b>{rs(sum.to_collect)}</b></div>
      <div className="stat"><span className="muted">Received this month</span><b>{rs(sum.received_month)}</b></div></div>}
    <div className="card"><h2>Find a customer</h2><Err msg={err} />
      <div className="row"><input type="search" aria-label="Search customers" placeholder="Search by phone number or name" value={search} onChange={e => setSearch(e.target.value)} /></div>
      {list.length === 0 && <p className="muted">No customer found. Add them below.</p>}
      {list.map(c => <div key={c.id} className="cust" role="button" tabIndex={0} onClick={() => open(c.id)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(c.id))}><span className="cname">{c.name}</span><span className="cphone">{c.phone}</span><Bal v={c.balance} /></div>)}</div>
    <form className="card" onSubmit={add}><h2>Add a new customer</h2>
      <div className="row"><input aria-label="Customer name" placeholder="Name" value={nw.name} onChange={e => setNw({ ...nw, name: e.target.value })} required />
        <input aria-label="Customer phone number" placeholder="10-digit phone" inputMode="numeric" value={nw.phone} onChange={e => setNw({ ...nw, phone: e.target.value })} required />
        <button className="ok">Add customer</button></div></form>
  </>;
}

const blank = () => ({ description: '', quantity: 1, unit: '', lineTotal: '', needsReview: false });

function BillEditor({ customer, onSaved }) {
  const [items, setItems] = useState([blank()]), [img, setImg] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [paid, setPaid] = useState(''), [key, setKey] = useState(() => crypto.randomUUID()), [done, setDone] = useState(null), [seenName, setSeenName] = useState('');
  const [copied, setCopied] = useState(false);
  const total = items.reduce((s, i) => s + Math.round((parseFloat(i.lineTotal) || 0) * 100), 0) / 100;
  const upd = (n, k, v) => setItems(items.map((it, i) => i === n ? { ...it, [k]: v, ...(k === 'lineTotal' || k === 'description' ? { needsReview: false } : {}) } : it));
  const scan = async e => {
    const file = e.target.files[0]; if (!file) return; setErr(''); setBusy(true); setImg(URL.createObjectURL(file));
    try {
      const fd = new FormData(); fd.append('image', file);
      const r = await api('/ai/scan-list', { method: 'POST', form: fd });
      setSeenName(r.customerName || ''); setItems(r.items.length ? r.items.map(i => ({ ...i, lineTotal: i.lineTotal ?? '' })) : [blank()]);
    } catch (x) { setErr(x.message + ' You can still type the items yourself.'); } setBusy(false); e.target.value = '';
  };
  const unresolved = items.some(i => !i.description.trim() || i.lineTotal === '' || isNaN(parseFloat(i.lineTotal)));
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const sent = items.map(i => ({ description: i.description, quantity: i.quantity, unit: i.unit, lineTotal: i.lineTotal }));
      const r = await api('/bills', { method: 'POST', body: { customerId: customer.id, idempotencyKey: key, paidNow: paid || 0, items: sent } });
      setDone({ ...r, sent, paidNow: Number(paid || 0) }); onSaved();
    } catch (x) { setErr(x.message); } setBusy(false);
  };
  if (done) {
    // Full receipt text is inside the message, so it works even without a public link.
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const msg = [`${localStorage.getItem('shop') || 'Shop'} — bill for ${customer.name}`,
      ...done.sent.map(i => `• ${i.description} ${i.quantity}${i.unit ? ' ' + i.unit : ''} — ${rs(i.lineTotal)}`),
      `Total: ${rs(done.total)}`, ...(done.paidNow ? [`Paid now: ${rs(done.paidNow)}`] : []),
      `Balance due: ${rs(done.balance)}`, ...(local ? [] : [`Receipt: ${location.origin}/r/${done.receiptToken}`]), 'Thank you!'].join('\n');
    const copy = async () => { try { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setErr('Copy failed. Select the text manually.'); } };
    return <div className="card"><h2>Bill saved: {rs(done.total)}</h2><p>New balance: <Bal v={done.balance} /></p>
      <h2 style={{ fontSize: 16 }}>Send the receipt to {customer.name}</h2>
      <div className="row">
        <a href={`https://wa.me/91${customer.phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><button className="ok">WhatsApp</button></a>
        <a href={`sms:+91${customer.phone}?&body=${encodeURIComponent(msg)}`}><button>SMS</button></a>
        <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
        <button className="ghost" onClick={() => { setDone(null); setItems([blank()]); setImg(null); setPaid(''); setKey(crypto.randomUUID()); }}>New bill</button></div>
      <pre className="chat pre" style={{ fontFamily: 'inherit' }}>{msg}</pre>
      <p className="muted">WhatsApp opens a ready message to {customer.name}. SMS opens your phone's messaging app, so use it on a phone. Both need you to press send.</p></div>;
  }
  return <div className="card"><h2>New bill</h2><Err msg={err} />
    <div className="row"><label><input type="file" aria-label="Photo of handwritten note" accept="image/*" capture="environment" onChange={scan} disabled={busy} /></label>
      <span className="muted">{busy ? 'Reading the note with Gemma 4…' : 'Photo of the handwritten note'}</span></div>
    {seenName && <p className="muted">Name written on note: {seenName}</p>}
    <div className="split"><div>{img ? <img className="thumb" src={img} alt="Handwritten note" /> : <p className="muted">The photo appears here next to the items it was read into.</p>}</div>
      <div>{items.map((it, n) => <div key={n} className={'item' + (it.needsReview ? ' warnrow' : '')}>
        <input aria-label="Item" placeholder="Item" value={it.description} onChange={e => upd(n, 'description', e.target.value)} />
        <input aria-label="Quantity" placeholder="Qty" inputMode="decimal" value={it.quantity} onChange={e => upd(n, 'quantity', e.target.value)} />
        <input aria-label="Unit" placeholder="Unit" value={it.unit} onChange={e => upd(n, 'unit', e.target.value)} />
        <input aria-label="Amount in rupees" placeholder={it.needsReview ? 'Enter price' : '₹ Amount'} inputMode="decimal" value={it.lineTotal} onChange={e => upd(n, 'lineTotal', e.target.value)} />
        <button className="ghost" aria-label="Remove item" onClick={() => setItems(items.filter((_, i) => i !== n))}>✕</button></div>)}
        <button className="ghost" onClick={() => setItems([...items, blank()])}>+ Add item</button>
        {items.some(i => i.needsReview) && <p className="muted">Highlighted rows need a check. Prices are never guessed.</p>}</div></div>
    <hr /><div className="row"><b>Total: {rs(total)}</b><input style={{ maxWidth: 160, flex: 'none' }} placeholder="Paid now (₹)" inputMode="decimal" value={paid} onChange={e => setPaid(e.target.value)} />
      <button className="ok" disabled={busy || unresolved} onClick={save}>Confirm and save bill</button></div>
    {unresolved && <p className="muted">Fill in every item and price to confirm.</p>}</div>;
}

function Customer({ id, back, onCtx }) {
  const [saving, setSaving] = useState(false), [d, setD] = useState(null), [err, setErr] = useState(''), [pay, setPay] = useState({ amount: '', method: 'upi', reference: '' });
  const load = () => api(`/customers/${id}/ledger`).then(setD).catch(x => setErr(x.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (d) onCtx({ id: d.customer.id, name: d.customer.name }); }, [d && d.customer.id]);
  const record = async e => {
    e.preventDefault(); if (saving) return; setErr(''); setSaving(true);
    try { await api(`/customers/${id}/payments`, { method: 'POST', body: pay }); setPay({ ...pay, amount: '', reference: '' }); load(); } catch (x) { setErr(x.message); }
    setSaving(false);
  };
  if (!d) return <><button className="ghost" onClick={back}>← Back</button><Err msg={err} /></>;
  const c = d.customer;
  const history = [...d.bills.map(b => ({ t: b.created_at, bill: b })), ...d.payments.map(p => ({ t: p.created_at, pay: p }))].sort((a, b) => new Date(b.t) - new Date(a.t));
  return <><button className="ghost" onClick={back}>← Back</button>
    <div className="card custhead"><span className="avatar" aria-hidden="true">{c.name.trim()[0].toUpperCase()}</span>
      <div className="custname"><h2>{c.name}</h2><span className="muted">{c.phone}</span></div>
      <div className="custbal"><span className="muted">Outstanding balance</span><div className={'bigbal ' + (Number(c.balance) > 0 ? 'due' : 'clear')}>{rs(c.balance)}</div><Bal v={c.balance} /></div></div>
    <BillEditor customer={c} onSaved={load} />
    <form className="card" onSubmit={record}><h2>Record a payment</h2><Err msg={err} />
      <div className="row"><input aria-label="Payment amount in rupees" placeholder="Amount ₹" inputMode="decimal" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} required />
        <select aria-label="Payment method" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}><option value="upi">UPI</option><option value="cash">Cash</option></select>
        <input aria-label="UPI reference (optional)" placeholder="UPI reference (optional)" value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} />
        <button className="ok" disabled={saving}>{saving ? 'Saving…' : 'Save payment'}</button></div><p className="muted">Only record a payment after you have received it.</p></form>
    <div className="card"><h2>History</h2>{history.length === 0 && <p className="muted">No bills or payments yet.</p>}
      {history.map((h, i) => h.bill
        ? <div key={i} className="hist"><span className="what"><span className="badge credit">Credit given</span> {h.bill.items.map(x => x.description).join(', ')}<span className="when">{day(h.t)}</span></span><b className="due">+{rs(h.bill.total)}</b></div>
        : <div key={i} className="hist"><span className="what"><span className="badge paid">Payment received</span> {h.pay.method.toUpperCase()}{h.pay.reference ? ' · ' + h.pay.reference : ''}<span className="when">{day(h.t)}</span></span><b className="clear">−{rs(h.pay.amount)}</b></div>)}</div></>;
}

export default function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('token')), [cid, setCid] = useState(null), [ctx, setCtx] = useState(null), [open, setOpen] = useState(false);
  if (!authed) return <Auth onAuth={() => setAuthed(true)} />;
  const ready = !cid || (ctx && ctx.id === cid);
  return <div className="wrap"><header><div className="brand"><span className="logo" aria-hidden="true">₹</span><h1>{localStorage.getItem('shop')}<small>Smart-Katha</small></h1></div>
    <button className="ghost" onClick={() => { localStorage.clear(); setAuthed(false); }}>Sign out</button></header>
    <div className="layout">
      <main>{cid ? <Customer id={cid} back={() => { setCid(null); setCtx(null); }} onCtx={setCtx} /> : <Home open={setCid} />}</main>
      <aside className={'chatdock' + (open ? ' open' : '')}>
        {ready ? <ChatPanel key={cid ? 'c' + cid : 'shop'} customer={cid ? ctx : null} onClose={() => setOpen(false)} /> : <section className="chatbox"><p className="muted" style={{ padding: 16 }}>Loading assistant…</p></section>}</aside>
      <button className="fab" onClick={() => setOpen(true)} aria-label="Open ledger assistant">✦ Ask</button></div></div>;
}
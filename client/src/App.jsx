import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LANGS, LangCtx, makeT, useLang } from './i18n.js';
import { speak, useSpeech } from './speech.js';

const rs = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const when = d => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

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
const Bal = ({ v }) => {
  const { t } = useLang();
  return Number(v) > 0 ? <span className="badge due">⏳ {t('due', { amt: rs(v) })}</span> : <span className="badge clear">✓ {t('settled')}</span>;
};

function LangPick() {
  const { lang, setLang, t } = useLang();
  return <select className="langpick" aria-label={t('language')} value={lang} onChange={e => setLang(e.target.value)}>
    {Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>;
}

// Microphone button used for bill / payment dictation. Calls onText(transcript) when the person stops speaking.
function Mic({ onText, label, continuous = false }) {
  const { t, speech } = useLang();
  const sp = useSpeech(speech, onText, continuous);
  if (!sp.supported) return <span className="muted">{t('voiceNo')}</span>;
  return <>
    <button type="button" className={'mic' + (sp.listening ? ' live' : '')} onClick={sp.listening ? sp.stop : sp.start} aria-pressed={sp.listening}>
      {sp.listening ? '⏹' : '🎤'} {label}</button>
    {sp.listening && <span className="muted livetext" role="status">{sp.interim || t('listening')}</span>}
    {sp.error === 'blocked' && <span className="err-inline">{t('micBlocked')}</span>}
  </>;
}

function Auth({ onAuth }) {
  const { t } = useLang();
  const [mode, setMode] = useState('login'), [f, setF] = useState({}), [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const go = async e => {
    e.preventDefault(); setErr('');
    try { const r = await api('/auth/' + mode, { method: 'POST', body: f }); localStorage.setItem('token', r.token); localStorage.setItem('shop', r.shopName); onAuth(); }
    catch (x) { setErr(x.message); }
  };
  return <div className="wrap" style={{ maxWidth: 420 }}>
    <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}><h1>Smart-Katha</h1><LangPick /></div>
    <p className="muted">{t('tagline')}</p>
    <form className="card" onSubmit={go}>
      <h2>{mode === 'login' ? t('signIn') : t('createShop')}</h2><Err msg={err} />
      {mode === 'register' && <div className="row"><input aria-label={t('shopName')} placeholder={t('shopName')} onChange={set('shopName')} required /></div>}
      <div className="row"><input type="email" aria-label={t('email')} autoComplete="email" placeholder={t('email')} onChange={set('email')} required /></div>
      <div className="row"><input type="password" aria-label={t('password')} autoComplete="current-password" placeholder={t('password')} onChange={set('password')} required /></div>
      <div className="row"><button className="ok">{mode === 'login' ? t('signIn') : t('createBtn')}</button>
        <button type="button" className="ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? t('newShop') : t('haveAcc')}</button></div>
    </form></div>;
}

// Right-hand assistant. Chats are saved on the server, so history survives reloads and new logins.
function ChatPanel({ customer, onClose }) {
  const { t, lang, speech } = useLang();
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
    if (!window.confirm(t('delChat'))) return;
    try { await api('/chats/' + id, { method: 'DELETE' }); if (id === chatId) newChat(); loadHistory(); } catch (x) { setErr(x.message); }
  };
  const ask = async raw => {
    const question = raw.trim(); if (question.length < 2 || busy) return;
    setText(''); setErr(''); setBusy(true); setView('chat'); setMsgs(m => [...m, { role: 'user', content: question }]);
    try {
      const r = await api('/chats/ask', { method: 'POST', body: { question, chatId, customerId: cid, lang } });
      setChatId(r.chatId); setMsgs(m => [...m, { role: 'assistant', content: r.answer, viaAI: r.viaAI, ms: r.ms }]); loadHistory();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const sp = useSpeech(speech, ask); // speak a question; it is sent automatically when you stop talking
  const chips = customer ? t('custChips', { n: customer.name }) : t('shopChips');
  return <section className="chatbox" aria-label={t('assistant')}>
    <div className="chathead">
      <div><h2>{t('assistant')}</h2><span className="ctxpill">{customer ? t('about', { name: customer.name }) : t('allCust')}</span></div>
      <div className="chatbtns">
        <button className="ghost" onClick={newChat}>{t('newChat')}</button>
        <button className={view === 'history' ? 'ok' : 'ghost'} onClick={() => setView(view === 'history' ? 'chat' : 'history')} aria-pressed={view === 'history'}>{t('history')}</button>
        <button className="ghost only-m" onClick={onClose} aria-label="Close">✕</button></div></div>
    {view === 'history'
      ? <div className="chatbody" aria-label={t('history')}>
          {history.length === 0 && <p className="muted">{t('noChats')}</p>}
          {history.map(h => <div className={'hrow' + (h.id === chatId ? ' on' : '')} key={h.id}>
            <button className="hopen" onClick={() => openChat(h.id)}><span className="htitle">{h.title}</span><span className="muted">{when(h.updated_at)}</span></button>
            <button className="hdel" onClick={() => removeChat(h.id)} aria-label={'Delete chat: ' + h.title}>🗑</button></div>)}
          <div ref={end} /></div>
      : <div className="chatbody" role="log" aria-live="polite">
          {msgs.length === 0 && <div className="intro"><p><b>{customer ? t('askCust', { name: customer.name }) : t('askShop')}</b></p>
            <p className="muted">{t('fromLedger')}</p>
            <div className="chips">{chips.map(c => <button key={c} className="chip" disabled={busy} onClick={() => ask(c)}>{c}</button>)}</div></div>}
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={i} className="bubble user">{m.content}</div>
            : <div key={i} className="bubble bot">{m.content}
                <span className="meta">
                  {m.viaAI === true && <>Gemma 4{m.ms != null ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}</>}
                  {m.viaAI === false && 'Backup keyword matching (Gemma unavailable)'}
                  <button type="button" className="spk" onClick={() => speak(m.content, speech)} aria-label={t('readAloud')} title={t('readAloud')}>🔊</button></span></div>)}
          {busy && <div className="bubble bot muted">{t('thinking')}</div>}
          {err && <div className="err" role="alert">{err}</div>}
          <div ref={end} /></div>}
    <form className="composer" onSubmit={e => { e.preventDefault(); ask(text); }}>
      {sp.supported && <button type="button" className={'mic icon' + (sp.listening ? ' live' : '')} onClick={sp.listening ? sp.stop : sp.start} aria-pressed={sp.listening} aria-label={sp.listening ? '⏹' : '🎤'}>{sp.listening ? '⏹' : '🎤'}</button>}
      <input aria-label={t('askPhShop')} value={sp.listening ? sp.interim : text} onChange={e => setText(e.target.value)} readOnly={sp.listening}
        placeholder={sp.listening ? t('listening') : customer ? t('askPhCust', { name: customer.name }) : t('askPhShop')} maxLength={300} />
      <button className="ok" disabled={busy || text.trim().length < 2}>{t('send')}</button></form>
  </section>;
}

function Home({ open }) {
  const { t } = useLang();
  const [list, setList] = useState([]), [search, setSearch] = useState(''), [nw, setNw] = useState({ name: '', phone: '' }), [err, setErr] = useState(''), [sum, setSum] = useState(null);
  const load = s => api('/customers' + (s ? '?phone=' + encodeURIComponent(s) : '')).then(setList).catch(x => setErr(x.message));
  useEffect(() => { load(search); }, [search]);
  useEffect(() => { api('/summary').then(setSum).catch(() => {}); }, []);
  const add = async e => {
    e.preventDefault(); setErr('');
    try { const c = await api('/customers', { method: 'POST', body: nw }); open(c.id); } catch (x) { setErr(x.message); }
  };
  return <>
    <div className="pagehead"><h2>{t('dashboard')}</h2><p className="muted">{t('dashSub')}</p></div>
    {sum && <div className="stats">
      <div className="stat"><span className="muted">{t('customers')}</span><b>{sum.customers}</b></div>
      <div className="stat hot"><span className="muted">{t('toCollect', { n: sum.owing })}</span><b>{rs(sum.to_collect)}</b></div>
      <div className="stat"><span className="muted">{t('received')}</span><b>{rs(sum.received_month)}</b></div></div>}
    <div className="card"><h2>{t('findCust')}</h2><Err msg={err} />
      <div className="row"><input type="search" aria-label={t('search')} placeholder={t('search')} value={search} onChange={e => setSearch(e.target.value)} /></div>
      {list.length === 0 && <p className="muted">{t('noCust')}</p>}
      {list.map(c => <div key={c.id} className="cust" role="button" tabIndex={0} onClick={() => open(c.id)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(c.id))}><span className="cname">{c.name}</span><span className="cphone">{c.phone}</span><Bal v={c.balance} /></div>)}</div>
    <form className="card" onSubmit={add}><h2>{t('addNew')}</h2>
      <div className="row"><input aria-label={t('name')} placeholder={t('name')} value={nw.name} onChange={e => setNw({ ...nw, name: e.target.value })} required />
        <input aria-label={t('phone')} placeholder={t('phone')} inputMode="numeric" value={nw.phone} onChange={e => setNw({ ...nw, phone: e.target.value })} required />
        <button className="ok">{t('addCust')}</button></div></form>
  </>;
}

const blank = () => ({ description: '', quantity: 1, unit: '', lineTotal: '', needsReview: false });

function BillEditor({ customer, onSaved }) {
  const { t } = useLang();
  const [items, setItems] = useState([blank()]), [img, setImg] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [paid, setPaid] = useState(''), [key, setKey] = useState(() => crypto.randomUUID()), [done, setDone] = useState(null), [seenName, setSeenName] = useState('');
  const [copied, setCopied] = useState(false), [heard, setHeard] = useState(''), [vbusy, setVbusy] = useState(false);
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
  // Voice: transcript -> Gemma -> rows appended to the editor. Nothing is saved until the shopkeeper confirms.
  const onVoice = async text => {
    setHeard(text); setErr(''); setVbusy(true);
    try {
      const r = await api('/ai/parse-voice', { method: 'POST', body: { transcript: text, mode: 'bill' } });
      if (r.items.length) setItems(cur => [...cur.filter(i => i.description.trim() || String(i.lineTotal) !== ''), ...r.items.map(i => ({ ...i, lineTotal: i.lineTotal ?? '' }))]);
      if (r.paidNow) setPaid(String(r.paidNow));
    } catch (x) { setErr(x.message); }
    setVbusy(false);
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
    return <div className="card"><h2>{t('billSaved')}: {rs(done.total)}</h2><p>{t('newBal')}: <Bal v={done.balance} /></p>
      <h2 style={{ fontSize: 16 }}>{t('sendReceipt', { name: customer.name })}</h2>
      <div className="row">
        <a href={`https://wa.me/91${customer.phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><button className="ok">WhatsApp</button></a>
        <a href={`sms:+91${customer.phone}?&body=${encodeURIComponent(msg)}`}><button>SMS</button></a>
        <button className="ghost" onClick={copy}>{copied ? t('copied') : t('copyMsg')}</button>
        <button className="ghost" onClick={() => { setDone(null); setItems([blank()]); setImg(null); setPaid(''); setHeard(''); setKey(crypto.randomUUID()); }}>{t('newBill')}</button></div>
      <pre className="chat pre" style={{ fontFamily: 'inherit' }}>{msg}</pre></div>;
  }
  return <div className="card"><h2>{t('newBill')}</h2><Err msg={err} />
    <div className="row"><label><input type="file" aria-label={t('notePhoto')} accept="image/*" capture="environment" onChange={scan} disabled={busy} /></label>
      <span className="muted">{busy ? t('reading') : t('notePhoto')}</span></div>
    <div className="row"><Mic label={t('speakBill')} continuous onText={onVoice} />{vbusy && <span className="muted">{t('parsing')}</span>}</div>
    {!heard && <p className="muted">{t('voiceHintBill')}</p>}
    {heard && <p className="muted heard">{t('heard')}: “{heard}” — {t('checkBelow')}</p>}
    {seenName && <p className="muted">Name written on note: {seenName}</p>}
    <div className="split"><div>{img ? <img className="thumb" src={img} alt="Handwritten note" /> : <p className="muted">{t('photoHere')}</p>}</div>
      <div>{items.map((it, n) => <div key={n} className={'item' + (it.needsReview ? ' warnrow' : '')}>
        <input aria-label={t('item')} placeholder={t('item')} value={it.description} onChange={e => upd(n, 'description', e.target.value)} />
        <input aria-label={t('qty')} placeholder={t('qty')} inputMode="decimal" value={it.quantity} onChange={e => upd(n, 'quantity', e.target.value)} />
        <input aria-label={t('unit')} placeholder={t('unit')} value={it.unit} onChange={e => upd(n, 'unit', e.target.value)} />
        <input aria-label={t('amount')} placeholder={it.needsReview ? t('enterPrice') : t('amount')} inputMode="decimal" value={it.lineTotal} onChange={e => upd(n, 'lineTotal', e.target.value)} />
        <button className="ghost" aria-label="Remove item" onClick={() => setItems(items.filter((_, i) => i !== n))}>✕</button></div>)}
        <button className="ghost" onClick={() => setItems([...items, blank()])}>{t('addItem')}</button>
        {items.some(i => i.needsReview) && <p className="muted">{t('reviewHint')}</p>}</div></div>
    <hr /><div className="row"><b>{t('total')}: {rs(total)}</b><input style={{ maxWidth: 160, flex: 'none' }} placeholder={t('paidNow')} inputMode="decimal" value={paid} onChange={e => setPaid(e.target.value)} />
      <button className="ok" disabled={busy || vbusy || unresolved} onClick={save}>{t('confirm')}</button></div>
    {unresolved && <p className="muted">{t('fillAll')}</p>}</div>;
}

function Customer({ id, back, onCtx }) {
  const { t } = useLang();
  const [saving, setSaving] = useState(false), [d, setD] = useState(null), [err, setErr] = useState(''), [pay, setPay] = useState({ amount: '', method: 'upi', reference: '' });
  const [vbusy, setVbusy] = useState(false);
  const load = () => api(`/customers/${id}/ledger`).then(setD).catch(x => setErr(x.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (d) onCtx({ id: d.customer.id, name: d.customer.name }); }, [d && d.customer.id]);
  const record = async e => {
    e.preventDefault(); if (saving) return; setErr(''); setSaving(true);
    try { await api(`/customers/${id}/payments`, { method: 'POST', body: pay }); setPay({ ...pay, amount: '', reference: '' }); load(); } catch (x) { setErr(x.message); }
    setSaving(false);
  };
  // Voice payment: fills the form only. The shopkeeper still presses Save.
  const onVoicePay = async text => {
    setErr(''); setVbusy(true);
    try {
      const r = await api('/ai/parse-voice', { method: 'POST', body: { transcript: text, mode: 'payment' } });
      setPay(p => ({ ...p, amount: r.amount != null ? String(r.amount) : p.amount, method: r.method || p.method }));
    } catch (x) { setErr(x.message); }
    setVbusy(false);
  };
  if (!d) return <><button className="ghost" onClick={back}>{t('back')}</button><Err msg={err} /></>;
  const c = d.customer;
  const history = [...d.bills.map(b => ({ t: b.created_at, bill: b })), ...d.payments.map(p => ({ t: p.created_at, pay: p }))].sort((a, b) => new Date(b.t) - new Date(a.t));
  return <><button className="ghost" onClick={back}>{t('back')}</button>
    <div className="card custhead"><span className="avatar" aria-hidden="true">{c.name.trim()[0].toUpperCase()}</span>
      <div className="custname"><h2>{c.name}</h2><span className="muted">{c.phone}</span></div>
      <div className="custbal"><span className="muted">{t('outstanding')}</span><div className={'bigbal ' + (Number(c.balance) > 0 ? 'due' : 'clear')}>{rs(c.balance)}</div><Bal v={c.balance} /></div></div>
    <BillEditor customer={c} onSaved={load} />
    <form className="card" onSubmit={record}><h2>{t('recPay')}</h2><Err msg={err} />
      <div className="row"><Mic label={t('speakPay')} onText={onVoicePay} />{vbusy && <span className="muted">{t('parsing')}</span>}</div>
      <div className="row"><input aria-label={t('payAmt')} placeholder={t('payAmt')} inputMode="decimal" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} required />
        <select aria-label="Payment method" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}><option value="upi">UPI</option><option value="cash">{t('cash')}</option></select>
        <input aria-label={t('upiRef')} placeholder={t('upiRef')} value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} />
        <button className="ok" disabled={saving || vbusy}>{saving ? t('saving') : t('savePay')}</button></div><p className="muted">{t('payNote')}</p></form>
    <div className="card"><h2>{t('history')}</h2>{history.length === 0 && <p className="muted">{t('noHist')}</p>}
      {history.map((h, i) => h.bill
        ? <div key={i} className="hist"><span className="what"><span className="badge credit">{t('credit')}</span> {h.bill.items.map(x => x.description).join(', ')}<span className="when">{day(h.t)}</span></span><b className="due">+{rs(h.bill.total)}</b></div>
        : <div key={i} className="hist"><span className="what"><span className="badge paid">{t('payRecv')}</span> {h.pay.method.toUpperCase()}{h.pay.reference ? ' · ' + h.pay.reference : ''}<span className="when">{day(h.t)}</span></span><b className="clear">−{rs(h.pay.amount)}</b></div>)}</div></>;
}

function Shell() {
  const { t } = useLang();
  const [authed, setAuthed] = useState(!!localStorage.getItem('token')), [cid, setCid] = useState(null), [ctx, setCtx] = useState(null), [open, setOpen] = useState(false);
  if (!authed) return <Auth onAuth={() => setAuthed(true)} />;
  const ready = !cid || (ctx && ctx.id === cid);
  return <div className="wrap"><header><div className="brand"><span className="logo" aria-hidden="true">₹</span><h1>{localStorage.getItem('shop')}<small>Smart-Katha</small></h1></div>
    <div className="hdr-right"><LangPick /><button className="ghost" onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('shop'); setAuthed(false); }}>{t('signOut')}</button></div></header>
    <div className="layout">
      <main>{cid ? <Customer id={cid} back={() => { setCid(null); setCtx(null); }} onCtx={setCtx} /> : <Home open={setCid} />}</main>
      <aside className={'chatdock' + (open ? ' open' : '')}>
        {ready ? <ChatPanel key={cid ? 'c' + cid : 'shop'} customer={cid ? ctx : null} onClose={() => setOpen(false)} /> : <section className="chatbox"><p className="muted" style={{ padding: 16 }}>{t('thinking')}</p></section>}</aside>
      <button className="fab" onClick={() => setOpen(true)} aria-label={t('assistant')}>✦ {t('assistant')}</button></div></div>;
}

export default function App() {
  const [lang, setLangState] = useState(() => { const l = localStorage.getItem('lang'); return LANGS[l] ? l : 'en'; });
  const value = useMemo(() => ({
    lang, t: makeT(lang), speech: LANGS[lang].speech,
    setLang: l => { localStorage.setItem('lang', l); setLangState(l); },
  }), [lang]);
  return <LangCtx.Provider value={value}><Shell /></LangCtx.Provider>;
}
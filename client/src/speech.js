import { useEffect, useRef, useState } from 'react';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

// Browser speech-to-text. `locale` like 'te-IN'. `onFinal(text)` runs once when the user stops talking / taps stop.
export function useSpeech(locale, onFinal, continuous = false) {
  const [listening, setListening] = useState(false), [interim, setInterim] = useState(''), [error, setError] = useState('');
  const rec = useRef(null), cb = useRef(onFinal);
  cb.current = onFinal;
  useEffect(() => () => { try { rec.current && rec.current.abort(); } catch {} }, []);
  const stop = () => { try { rec.current && rec.current.stop(); } catch {} };
  const start = () => {
    if (!SR || listening) return;
    setError(''); setInterim('');
    const r = new SR(); rec.current = r;
    r.lang = locale; r.interimResults = true; r.continuous = continuous; r.maxAlternatives = 1;
    let finalText = '';
    r.onstart = () => setListening(true);
    r.onresult = e => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript + ' '; else live += res[0].transcript;
      }
      setInterim((finalText + live).trim());
    };
    r.onerror = e => setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'blocked' : e.error === 'no-speech' || e.error === 'aborted' ? '' : e.error);
    r.onend = () => { setListening(false); setInterim(''); const txt = finalText.trim(); if (txt) cb.current(txt); };
    try { r.start(); } catch { setListening(false); }
  };
  return { start, stop, listening, interim, error, supported: !!SR };
}

// Read an answer aloud (uses voices installed on the device; Telugu voice may not exist on every device).
export function speak(text, locale) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = locale; window.speechSynthesis.speak(u);
}
import 'dotenv/config';
for (const model of ['gemma-4-31b-it', 'gemma-4-26b-a4b-it']) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] }),
  });
  console.log(model, r.status, (await r.text()).slice(0, 400));
}
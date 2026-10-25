# Smart-Katha 📒

**A digital credit ledger for small shops, powered by open-weight Gemma 4.**
Photograph a handwritten note or just speak, in English, Hindi or Telugu. The AI reads it, flags anything uncertain, and only saves after the shopkeeper confirms.

> Built for **Hacktoberfest Hack Day Hyderabad × Kramer's Community** (MLH) 

<!-- Add a demo GIF or screenshots here -->
<!-- ![Dashboard](docs/dashboard.png) ![Bill from a handwritten note](docs/scan.png) -->

**Live demo:** `<your-deployed-url>`  ·  **Demo video:** `<link>`

---

## The problem

Many small shops give goods on credit and track it in a paper *katha* (notebook). Notes get lost, totals are miscalculated, dues are forgotten, and typing everything into an app is slow, especially in a local language.

## The idea

> **AI proposes → the human confirms → the database computes.**

Gemma 4 reads handwriting, understands speech, classifies questions and translates. It **never** decides a balance and **never** writes to the ledger on its own. Every number a shopkeeper sees comes from SQL over confirmed records.

## Features

| | Feature | How it works |
|---|---|---|
| 📷 | **Handwritten note → bill** | Gemma 4 (vision) reads the photo into editable rows. Unclear or unpriced lines are highlighted, and prices are never guessed. |
| ✅ | **Confirm before saving** | The bill can't be saved until every item has a name and a price. |
| 🎤 | **Voice entry** | Speak a bill, a payment, or a new customer. Gemma structures the sentence into form fields. Optional "add automatically" for customers. |
| 💬 | **Ledger assistant** | Ask questions like "Who owes me the most?" or "When did Ramesh last pay?". Chats are saved with history. |
| 🌐 | **English / हिन्दी / తెలుగు** | UI, quick questions and AI answers are localized. Answers can be read aloud. |
| 🧾 | **Receipts** | Send via WhatsApp , copy the text, or share an unguessable public receipt link. |
| 📊 | **Dashboard** | Customers, total money to collect, and received this month. |
| 🛡️ | **Safe by design** | Idempotent billing, integer-paise totals, overpayment guards, per-shop data isolation. |

## Architecture

```mermaid
flowchart LR
  U[Shopkeeper<br/>photo · voice · text] --> C[React + Vite client]
  C -->|/api| S[Express server]
  S -->|SQL, parameterized| DB[(PostgreSQL)]
  S -->|generateContent| G[Gemma 4 via Gemini API]
  G --- V[gemma-4-31b-it<br/>handwriting vision]
  G --- F[gemma-4-26b-a4b-it<br/>intents · voice · translation]
```

### How a chat question is answered

```mermaid
sequenceDiagram
  participant UI as Client
  participant API as Server
  participant AI as Gemma 4
  participant DB as PostgreSQL
  UI->>API: question + scope (shop or customer) + language
  API->>AI: classify -> {"intent":"top_debtors","days":null}
  AI-->>API: intent only (tens of tokens)
  API->>DB: fixed, parameterized query for that intent
  DB-->>API: real numbers
  API->>AI: translate finished answer (only if not English)
  AI-->>API: translated text, numbers unchanged
  API-->>UI: answer + "Gemma 4 · 1.2s"
```

## How Gemma 4 is used

| Task | Model | Input → Output |
|---|---|---|
| Read a handwritten note | `gemma-4-31b-it` | image + prompt → JSON items (`needsReview` flags) |
| Classify a question | `gemma-4-26b-a4b-it` | text → `{intent, days}` (≈80 tokens) |
| Understand a spoken bill, payment or customer | `gemma-4-26b-a4b-it` | transcript → structured JSON |
| Translate an answer | `gemma-4-26b-a4b-it` | answer text → Hindi or Telugu, numbers preserved |

**Design choices**

- **Right-sized models:** the larger model only where accuracy matters (handwriting), the faster one for everything else. Each model is the other's fallback.
- **No text-to-SQL:** Gemma returns an *intent*, and the backend runs fixed queries. The model can't leak another shop's data or hallucinate a balance.
- **Small structured outputs:** short JSON keeps latency and cost low. Every response is extracted and validated with Zod.
- **Thinking mode off** (`minimal`) for fast 1–3 s responses, configurable for scans.
- **Resilient client:** timeouts, retries with back-off, model fallback, and a keyword-based intent fallback so the chat never goes dead.
- **Open weights:** the same prompts can run on self-hosted Gemma, so a shop's financial data doesn't have to leave your own infrastructure.

## Tech stack

- **Frontend:** React 18, Vite, plain CSS, Web Speech API (speech-to-text and read-aloud)
- **Backend:** Node.js, Express, Zod, JWT, bcryptjs, Multer
- **Database:** PostgreSQL
- **AI:** Gemma 4 (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) through the Gemini API

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL 13+
- A Gemini API key (create one in [Google AI Studio](https://aistudio.google.com))
- Chrome or Edge for voice features (the microphone needs `localhost` or HTTPS)

### 1. Clone

```bash
git clone <your-repo-url>
cd smart-katha
```

### 2. Database

```bash
createdb smartkatha
```

### 3. Server

```bash
cd server
cp .env.example .env      # then edit .env (see below)
npm install
npm run migrate           # creates the tables
node test-gemma.js        # optional: checks your API key and both models
npm run dev               # http://localhost:4000
```

### 4. Client

```bash
cd client
npm install
npm run dev               # http://localhost:5173 (proxies /api to :4000)
```

Open the client URL, register your shop, add a customer, and try a photo or the 🎤 button.

### Environment variables (`server/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | API port (default `4000`) |
| `DATABASE_URL` | yes | e.g. `postgres://postgres:password@localhost:5432/smartkatha` |
| `JWT_SECRET` | yes | Long random string used to sign login tokens |
| `GEMINI_API_KEY` | yes | Your Gemini API key |
| `GEMMA_MODEL` | no | Vision model (default `gemma-4-31b-it`) |
| `GEMMA_CHAT_MODEL` | no | Fast model (default `gemma-4-26b-a4b-it`) |
| `GEMMA_SCAN_THINKING` | no | Thinking level for note scans (default `minimal`) |
| `PUBLIC_URL` | no | Base URL used in receipt links |

> ⚠️ Never commit `.env`. Use `.env.example` as the template.

## API overview

All routes except auth and `/r/:token` need `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Create a shop / sign in |
| GET | `/api/summary` | Dashboard totals |
| GET / POST | `/api/customers` | Search (`?phone=` matches name or phone) / add |
| GET | `/api/customers/:id/ledger` | Customer bills and payments |
| POST | `/api/customers/:id/payments` | Record a payment |
| POST | `/api/ai/scan-list` | Image → structured bill items (multipart `image`) |
| POST | `/api/ai/parse-voice` | Transcript → bill, payment or customer (`mode`) |
| POST | `/api/bills/preview` | Validate items and compute the total |
| POST | `/api/bills` | Save a bill (idempotent via `idempotencyKey`) |
| GET | `/api/bills/:id` | Bill details |
| GET | `/api/chats` · `/api/chats/:id` | Chat history |
| POST | `/api/chats/ask` | Ask the assistant (`question`, `chatId`, `customerId`, `lang`) |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/r/:token` | Public receipt page |

### Assistant intents

- **Shop scope:** `shop_summary`, `customer_count`, `total_to_collect`, `customers_owing`, `top_debtors`, `total_received`, `total_sales`, `inactive_customers`
- **Customer scope:** `customer_summary`, `customer_balance`, `customer_purchases`, `customer_total_spent`, `customer_last_payment`, `customer_payments`

## Project structure

```
smart-katha/
├── server/
│   ├── index.js        # routes, ledger queries, chat flow, receipts
│   ├── ai.js           # all Gemma 4 calls: scan, intents, voice, translation
│   ├── db.js           # PostgreSQL pool
│   ├── schema.sql      # tables and indexes
│   ├── migrate.js      # applies schema.sql
│   └── test-gemma.js   # API key / model check
└── client/
    └── src/
        ├── App.jsx     # screens: auth, dashboard, customer, bill editor, chat
        ├── i18n.js     # English / Hindi / Telugu dictionaries
        ├── speech.js   # speech-to-text and read-aloud helpers
        └── style.css
```

## Safety and data integrity

- Balances are **computed**, never stored: confirmed bills minus confirmed payments.
- Money is totalled in integer paise to avoid floating-point errors.
- Bills use an **idempotency key**, so retries and double-taps can't duplicate them.
- Payments can't exceed the outstanding balance, and "paid now" can't exceed the bill total.
- Passwords are hashed with bcrypt, and every query is scoped by `shop_id`.
- Receipt links use a random 128-bit token.


## Acknowledgements

Built with [Gemma 4](https://ai.google.dev/gemma) for **Hacktoberfest Hack Day Hyderabad × Kramer's Community** on MLH.

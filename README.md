# Smart-Katha — AI digital khata (Gemma 4 + React + Express + PostgreSQL)

## Setup
1. Install Node 18+ and PostgreSQL. Create a DB: `createdb smartkatha`
2. Get a Gemini API key at https://aistudio.google.com/apikey
3. Backend:
   cd server && cp .env.example .env   # fill DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, GEMMA_MODEL
   npm install && npm run migrate && npm run dev      # http://localhost:4000
4. Frontend (new terminal):
   cd client && npm install && npm run dev            # http://localhost:5173
5. Open the app, register a shop, add a customer, scan a handwritten note.

GEMMA_MODEL must be the exact Gemma 4 model id shown in Google AI Studio's model list.
Receipts are public at /r/<token>; set PUBLIC_URL to your deployed backend URL so WhatsApp links work.

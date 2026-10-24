CREATE TABLE IF NOT EXISTS shops (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id), name TEXT NOT NULL, phone TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(shop_id, phone));
CREATE TABLE IF NOT EXISTS bills (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id), customer_id INT NOT NULL REFERENCES customers(id),
  total NUMERIC(12,2) NOT NULL CHECK (total >= 0), status TEXT NOT NULL DEFAULT 'confirmed', idempotency_key TEXT, receipt_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(shop_id, idempotency_key));
CREATE TABLE IF NOT EXISTS bill_items (id SERIAL PRIMARY KEY, bill_id INT NOT NULL REFERENCES bills(id) ON DELETE CASCADE, description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL, unit TEXT, line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0));
CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id), customer_id INT NOT NULL REFERENCES customers(id),
  bill_id INT REFERENCES bills(id), amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method TEXT NOT NULL DEFAULT 'cash', reference TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_bills_cust ON bills(shop_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_pay_cust ON payments(shop_id, customer_id);

CREATE TABLE IF NOT EXISTS chats (id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id), customer_id INT REFERENCES customers(id),
  title TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, chat_id INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, via_ai BOOLEAN, ms INT, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_chats_ctx ON chats(shop_id, customer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_msgs_chat ON chat_messages(chat_id, id);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  company VARCHAR(40) NOT NULL DEFAULT 'Filial',
  external_id INTEGER NOT NULL,
  supplier_id INTEGER,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  package TEXT,
  master_package TEXT,
  units_per_box INTEGER NOT NULL DEFAULT 1 CHECK (units_per_box > 0),
  min_boxes INTEGER NOT NULL DEFAULT 1 CHECK (min_boxes > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  list_unit_price NUMERIC(14,2),
  retail_unit_price NUMERIC(14,2),
  network_unit_price NUMERIC(14,2),
  department TEXT,
  section TEXT,
  source_category TEXT,
  category VARCHAR(40) NOT NULL,
  ean TEXT,
  stock_units NUMERIC(14,2) NOT NULL DEFAULT 0,
  image_path TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  price_date DATE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company, external_id)
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sold_at DATE NOT NULL,
  quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  revenue NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  external_id INTEGER,
  document VARCHAR(14) NOT NULL UNIQUE,
  person_type VARCHAR(4) NOT NULL CHECK (person_type IN ('CPF', 'CNPJ')),
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  phone VARCHAR(11) NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT,
  sales_channel VARCHAR(20) NOT NULL DEFAULT 'Varejo' CHECK (sales_channel IN ('Varejo', 'Redes')),
  postal_code VARCHAR(8),
  address_line TEXT,
  address_number TEXT,
  address_complement TEXT,
  neighborhood TEXT,
  city TEXT,
  state VARCHAR(2),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source VARCHAR(30) NOT NULL DEFAULT 'ecommerce',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  status VARCHAR(30) NOT NULL DEFAULT 'received',
  payment_plan VARCHAR(30) NOT NULL DEFAULT 'avista',
  total NUMERIC(14,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  boxes INTEGER NOT NULL CHECK (boxes > 0),
  units_per_box INTEGER NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL,
  line_total NUMERIC(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active, category);
CREATE INDEX IF NOT EXISTS idx_sales_product_date ON sales(product_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_customers_document ON customers(document);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_id);

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
  sales_multiple INTEGER NOT NULL DEFAULT 1 CHECK (sales_multiple > 0),
  min_boxes INTEGER NOT NULL DEFAULT 1 CHECK (min_boxes > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  list_unit_price NUMERIC(14,2),
  retail_unit_price NUMERIC(14,2),
  network_unit_price NUMERIC(14,2),
  department_code INTEGER,
  department TEXT,
  section_code INTEGER,
  section TEXT,
  source_category TEXT,
  category VARCHAR(40) NOT NULL,
  ean TEXT,
  manufacturer_code TEXT,
  ncm_code TEXT,
  stock_units NUMERIC(14,2) NOT NULL DEFAULT 0,
  image_path TEXT,
  image_data BYTEA,
  image_mime VARCHAR(50),
  image_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  image_updated_at TIMESTAMPTZ,
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
  supabase_user_id UUID,
  password_hash TEXT,
  sales_channel VARCHAR(20) NOT NULL DEFAULT 'Varejo' CHECK (sales_channel IN ('Varejo', 'Redes')),
  postal_code VARCHAR(8),
  address_line TEXT,
  address_number TEXT,
  address_complement TEXT,
  neighborhood TEXT,
  city TEXT,
  state VARCHAR(2),
  registration_status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (registration_status IN ('pending', 'approved')),
  approved_at TIMESTAMP,
  approved_by_staff_user_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source VARCHAR(30) NOT NULL DEFAULT 'ecommerce',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  status VARCHAR(30) NOT NULL DEFAULT 'analysis',
  winthor_order_number BIGINT,
  winthor_status_code VARCHAR(20),
  winthor_status_label VARCHAR(80),
  winthor_status_checked_at TIMESTAMP,
  winthor_entered_by_staff_user_id BIGINT,
  winthor_entered_at TIMESTAMP,
  payment_plan VARCHAR(30) NOT NULL DEFAULT 'avista',
  payment_plan_label VARCHAR(160),
  total NUMERIC(14,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  boxes INTEGER NOT NULL CHECK (boxes > 0),
  units INTEGER NOT NULL CHECK (units > 0),
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

CREATE TABLE IF NOT EXISTS staff_users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  supabase_user_id UUID,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'COMERCIAL', 'MARKETING')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  staff_user_id BIGINT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banners (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  image_path TEXT,
  image_data BYTEA,
  image_mime VARCHAR(50),
  target_url TEXT NOT NULL DEFAULT '#produtos',
  section_code INTEGER,
  destination_type VARCHAR(20) NOT NULL DEFAULT 'navigation' CHECK (destination_type IN ('navigation', 'sections', 'products', 'suppliers')),
  destination_values INTEGER[] NOT NULL DEFAULT '{}',
  navigation_path TEXT NOT NULL DEFAULT '/#produtos',
  placement VARCHAR(20) NOT NULL DEFAULT 'hero' CHECK (placement IN ('hero', 'catalog')),
  position INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMP,
  ends_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (image_path IS NOT NULL OR image_data IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS customer_commercial_conditions (
  customer_id BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  open_titles_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  open_orders_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  price_region INTEGER,
  restricted_supplier_ids INTEGER[] NOT NULL DEFAULT '{}',
  payment_plans JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Preços da PCTABPR por região (NUMREGIAO). price_1..price_7 = PTABELA1..PTABELA7;
-- a coluna usada em cada pedido vem do NUMPR do plano de pagamento (PCPLPAG).
CREATE TABLE IF NOT EXISTS region_prices (
  region INTEGER NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_1 NUMERIC(14,6),
  price_2 NUMERIC(14,6),
  price_3 NUMERIC(14,6),
  price_4 NUMERIC(14,6),
  price_5 NUMERIC(14,6),
  price_6 NUMERIC(14,6),
  price_7 NUMERIC(14,6),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (region, product_id)
);

CREATE TABLE IF NOT EXISTS product_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  source_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  deactivated_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  details TEXT
);

CREATE TABLE IF NOT EXISTS catalog_categories (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id BIGINT NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
  assigned_by BIGINT REFERENCES staff_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active, category);
CREATE INDEX IF NOT EXISTS idx_sales_product_date ON sales(product_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_customers_document ON customers(document);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_date ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_user ON staff_sessions(staff_user_id);
CREATE INDEX IF NOT EXISTS idx_banners_active_position ON banners(active, position);
CREATE INDEX IF NOT EXISTS idx_product_categories_category ON product_categories(category_id, product_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_product ON product_categories(product_id, category_id);

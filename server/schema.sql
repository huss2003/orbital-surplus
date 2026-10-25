-- ORBITAL SURPLUS schema. Money is integer cents (USD). Applied by ensureSchema() on boot.
create table if not exists meta (key text primary key, value jsonb not null);

create table if not exists products (
  id serial primary key,
  slug text unique not null,
  sku text unique not null,
  name text not null,
  category text not null default '',
  color text not null default '',
  price integer not null check (price >= 0),
  compare_at integer,
  currency text not null default 'USD',
  description text not null default '',
  materials jsonb not null default '[]',
  care jsonb not null default '[]',
  images jsonb not null default '[]',
  model jsonb not null default '{}',
  status text not null default 'active',      -- active | draft
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stock per size. `stock` is what can still be sold: a pending checkout takes units out
-- immediately (conditional UPDATE) and puts them back if the payment expires or is cancelled.
create table if not exists variants (
  product_id integer not null references products(id) on delete cascade,
  size text not null,
  stock integer not null default 0 check (stock >= 0),
  position integer not null default 0,
  primary key (product_id, size)
);

create table if not exists customers (
  id serial primary key,
  email text unique not null,
  name text not null default '',
  password_hash text,
  is_admin boolean not null default false,
  accepts_marketing boolean not null default false,
  default_address jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,                         -- sha256 of the cookie token
  customer_id integer not null references customers(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists auth_throttle (key text primary key, failures integer not null default 0, window_start timestamptz not null default now());

create table if not exists password_resets (
  id text primary key, customer_id integer not null references customers(id) on delete cascade,
  expires_at timestamptz not null, used boolean not null default false
);

create table if not exists discounts (
  code text primary key,
  kind text not null default 'percent',       -- percent | fixed
  value integer not null,                      -- percent (10 = 10%) or cents
  min_subtotal integer not null default 0,
  label text not null default '',
  active boolean not null default true,
  usage_limit integer,
  used integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists carts (
  id text primary key,
  customer_id integer references customers(id) on delete set null,
  items jsonb not null default '[]',          -- [{line_id, slug, size, quantity}]
  discount_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists order_number_seq start 1001;

create table if not exists orders (
  id serial primary key,
  number integer unique not null default nextval('order_number_seq'),
  token text unique not null,
  status text not null default 'pending',      -- pending | paid | fulfilled | cancelled | expired | refunded
  customer_id integer references customers(id) on delete set null,
  cart_id text,
  email text not null,
  name text not null default '',
  address jsonb not null default '{}',
  items jsonb not null default '[]',           -- [{slug, sku, name, size, quantity, unit_price, line_total, image}]
  subtotal integer not null,
  discount_code text,
  discount integer not null default 0,
  shipping jsonb not null default '{}',        -- {id, label, amount, eta}
  tax integer not null default 0,
  total integer not null,
  currency text not null default 'USD',
  stripe_session_id text unique,
  stripe_url text,
  payment_intent text,
  payment jsonb,                               -- {brand, last4}
  tracking jsonb,                              -- {carrier, number}
  refunded integer not null default 0,
  notes text,
  expires_at timestamptz,
  paid_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists orders_customer_idx on orders (customer_id);
create index if not exists orders_status_idx on orders (status, expires_at);

create table if not exists subscribers (email text primary key, source text not null default 'footer', created_at timestamptz not null default now());

create table if not exists messages (
  id serial primary key, name text not null, email text not null, body text not null,
  handled boolean not null default false, created_at timestamptz not null default now()
);

create table if not exists emails (
  id serial primary key, to_email text not null, subject text not null, html text not null,
  kind text not null default 'transactional', status text not null default 'logged', created_at timestamptz not null default now()
);

-- Webhook + order timeline log
create table if not exists events (
  id serial primary key,
  source text not null,                        -- stripe | system | admin
  type text not null,
  ref text,                                    -- stripe event id, order number …
  verified boolean not null default true,
  data jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists events_stripe_ref on events (ref) where source = 'stripe' and verified

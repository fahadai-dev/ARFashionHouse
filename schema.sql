-- ============================================================
-- কাপড়ের দোকান POS System — Supabase Schema
-- এই পুরো ফাইলটা Supabase Dashboard > SQL Editor এ পেস্ট করে RUN করুন
-- ============================================================

-- 1) SHOPS টেবিল (মাল্টি-টেনেন্ট এর জন্য, এখন একটা দোকান দিয়ে শুরু)
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  logo_url text,
  owner_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

-- 2) PROFILES টেবিল (owner/staff role সহ — একাধিক owner রাখা যায়, দেখুন add-second-owner.sql)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  shop_id uuid references shops(id) on delete cascade,
  full_name text,
  role text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz default now()
);

-- 3) PRODUCTS টেবিল
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  category text,
  size text,
  color text,
  code text not null,              -- QR বা বারকোড এর ভ্যালু
  code_type text not null default 'qr' check (code_type in ('qr','barcode')),
  cost_price numeric(10,2) default 0,
  sell_price numeric(10,2) not null default 0,
  stock_qty int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (shop_id, code)
);

create index if not exists idx_products_shop on products(shop_id);
create index if not exists idx_products_code on products(shop_id, code);

-- 4) SALES টেবিল (প্রতিটা বিক্রি/মেমো)
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  invoice_no text not null,
  items jsonb not null,             -- [{product_id, name, code, qty, price, discount, line_total}]
  subtotal numeric(10,2) not null default 0,
  discount_total numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  payment_method text default 'cash' check (payment_method in ('cash','bkash','nagad','card','due')),
  customer_name text,
  customer_phone text,
  customer_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (shop_id, invoice_no)
);

create index if not exists idx_sales_shop_date on sales(shop_id, created_at);

-- 5) CUSTOMERS টেবিল (বাকির খাতার গ্রাহক)
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  phone text,
  address text,
  due_amount numeric(10,2) not null default 0,
  created_at timestamptz default now()
);

create index if not exists idx_customers_shop on customers(shop_id);

-- 6) LEDGER_ENTRIES টেবিল (বাকি / জমার প্রতিটা লেনদেন)
create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  type text not null check (type in ('বাকি','জমা')),
  amount numeric(10,2) not null,
  note text,
  sale_id uuid references sales(id) on delete set null,
  created_by uuid references auth.users(id),
  entry_date timestamptz not null default now(),
  created_at timestamptz default now()
);

create index if not exists idx_ledger_customer on ledger_entries(customer_id);
create index if not exists idx_ledger_shop on ledger_entries(shop_id);

-- 7) প্রতিদিনের ইনভয়েস নাম্বার কাউন্টার
create table if not exists invoice_counters (
  shop_id uuid not null references shops(id) on delete cascade,
  day_key text not null,            -- 'YYYYMMDD'
  last_no int not null default 0,
  primary key (shop_id, day_key)
);

-- ============================================================
-- HELPER FUNCTIONS (security definer)
-- ============================================================

create or replace function my_shop_id()
returns uuid
language sql
security definer
stable
as $$
  select shop_id from profiles where id = auth.uid();
$$;

create or replace function is_owner()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select role = 'owner' from profiles where id = auth.uid()), false);
$$;

-- পরের ইনভয়েস নাম্বার জেনারেট করার ফাংশন (দিনভিত্তিক, যেমন 20260911-0007)
create or replace function next_invoice_no()
returns text
language plpgsql
security definer
as $$
declare
  v_shop uuid := my_shop_id();
  v_day text := to_char(now(), 'YYYYMMDD');
  v_no int;
begin
  insert into invoice_counters(shop_id, day_key, last_no)
  values (v_shop, v_day, 1)
  on conflict (shop_id, day_key)
  do update set last_no = invoice_counters.last_no + 1
  returning last_no into v_no;

  return v_day || '-' || lpad(v_no::text, 4, '0');
end;
$$;

-- নতুন ইউজার সাইনআপ হলে অটোমেটিক shop + profile বানানোর ট্রিগার
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  v_shop_id uuid;
begin
  insert into shops(name, owner_id)
  values (coalesce(new.raw_user_meta_data->>'shop_name', 'আমার দোকান'), new.id)
  returning id into v_shop_id;

  insert into profiles(id, shop_id, full_name, role)
  values (new.id, v_shop_id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table shops enable row level security;
alter table profiles enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table invoice_counters enable row level security;
alter table customers enable row level security;
alter table ledger_entries enable row level security;

-- shops: নিজের দোকান দেখতে/এডিট করতে পারবে
create policy shops_select on shops for select using (id = my_shop_id());
create policy shops_update on shops for update using (id = my_shop_id() and is_owner());

-- profiles: নিজের shop এর সবাইকে দেখতে পারবে, নিজেরটা এডিট করতে পারবে
create policy profiles_select on profiles for select using (shop_id = my_shop_id());
create policy profiles_update_self on profiles for update using (id = auth.uid());
create policy profiles_insert_owner on profiles for insert with check (shop_id = my_shop_id() and is_owner());

-- products: শুধু নিজের shop এর প্রোডাক্ট, সবাই CRUD করতে পারবে (owner+staff)
create policy products_all on products for all
  using (shop_id = my_shop_id())
  with check (shop_id = my_shop_id());

-- sales: শুধু নিজের shop এর বিক্রি
create policy sales_all on sales for all
  using (shop_id = my_shop_id())
  with check (shop_id = my_shop_id());

-- invoice_counters: ফাংশনের ভিতর দিয়েই ব্যবহার হয়, তাও RLS দিলাম
create policy counters_all on invoice_counters for all
  using (shop_id = my_shop_id())
  with check (shop_id = my_shop_id());

-- customers ও ledger_entries: শুধু নিজের shop এর
create policy customers_all on customers for all
  using (shop_id = my_shop_id())
  with check (shop_id = my_shop_id());

create policy ledger_all on ledger_entries for all
  using (shop_id = my_shop_id())
  with check (shop_id = my_shop_id());

-- ============================================================
-- শেষ। এবার Authentication > Providers এ গিয়ে Email/Password Enable করুন
-- এবং Authentication > Email Templates > Confirm signup বন্ধ রাখতে পারেন
-- (Settings > Auth > "Confirm email" OFF করলে সাইনআপের সাথে সাথেই লগইন হবে)
-- ============================================================
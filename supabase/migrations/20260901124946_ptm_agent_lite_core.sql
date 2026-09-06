create extension if not exists btree_gist;

create table public.ptm_properties (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  location text,
  timezone text not null default 'Africa/Harare',
  currency text not null default 'USD',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ptm_agents (
  id uuid primary key default gen_random_uuid(),
  agent_code text not null unique,
  display_name text not null,
  role text not null default 'agent' check (role in ('admin','agent')),
  active boolean not null default true,
  commission_type text not null default 'pending' check (commission_type in ('pending','percent','fixed')),
  commission_value numeric(12,2),
  created_at timestamptz not null default now()
);

create table public.ptm_agent_credentials (
  agent_id uuid primary key references public.ptm_agents(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table public.ptm_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ptm_properties(id) on delete cascade,
  rule_name text not null,
  nightly_rate numeric(12,2) not null check (nightly_rate >= 0),
  min_nights integer not null default 1 check (min_nights >= 1),
  max_nights integer,
  discount_percent numeric(5,2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  effective_from date,
  effective_to date,
  active boolean not null default true,
  approval_status text not null default 'draft' check (approval_status in ('draft','approved','retired')),
  created_at timestamptz not null default now(),
  check (max_nights is null or max_nights >= min_nights),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create table public.ptm_quotes (
  id uuid primary key default gen_random_uuid(),
  quote_code text not null unique,
  property_id uuid not null references public.ptm_properties(id),
  agent_id uuid references public.ptm_agents(id),
  guest_name text,
  check_in date not null,
  check_out date not null,
  nights integer not null check (nights > 0),
  nightly_rate numeric(12,2) not null check (nightly_rate >= 0),
  discount_percent numeric(5,2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  status text not null default 'issued' check (status in ('draft','issued','accepted','expired','converted','cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  check (check_out > check_in)
);

create table public.ptm_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null unique,
  property_id uuid not null references public.ptm_properties(id),
  quote_id uuid references public.ptm_quotes(id),
  agent_id uuid references public.ptm_agents(id),
  check_in date not null,
  check_out date not null,
  booking_status text not null default 'held' check (booking_status in ('held','confirmed','completed','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','part_paid','paid','refunded')),
  booking_value numeric(12,2),
  commission_amount numeric(12,2),
  commission_status text not null default 'pending_rule' check (commission_status in ('pending_rule','pending_booking','earned','paid','void')),
  source text not null default 'agent_lite',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out > check_in)
);

alter table public.ptm_bookings
  add constraint ptm_no_overlapping_live_bookings
  exclude using gist (
    property_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (booking_status in ('held','confirmed'));

create index ptm_quotes_agent_idx on public.ptm_quotes(agent_id);
create index ptm_quotes_dates_idx on public.ptm_quotes(property_id, check_in, check_out);
create index ptm_bookings_agent_idx on public.ptm_bookings(agent_id);
create index ptm_bookings_dates_idx on public.ptm_bookings(property_id, check_in, check_out);
create index ptm_pricing_property_idx on public.ptm_pricing_rules(property_id, active, approval_status);

alter table public.ptm_properties enable row level security;
alter table public.ptm_agents enable row level security;
alter table public.ptm_agent_credentials enable row level security;
alter table public.ptm_pricing_rules enable row level security;
alter table public.ptm_quotes enable row level security;
alter table public.ptm_bookings enable row level security;

revoke all on table public.ptm_properties from anon, authenticated;
revoke all on table public.ptm_agents from anon, authenticated;
revoke all on table public.ptm_agent_credentials from anon, authenticated;
revoke all on table public.ptm_pricing_rules from anon, authenticated;
revoke all on table public.ptm_quotes from anon, authenticated;
revoke all on table public.ptm_bookings from anon, authenticated;

insert into public.ptm_properties (code, name, location, timezone, currency)
values ('LOMBARD', 'PTM Exclusive - Lombard', 'Avenues, Harare', 'Africa/Harare', 'USD');

with p as (
  select id from public.ptm_properties where code = 'LOMBARD'
)
insert into public.ptm_bookings (
  booking_code, property_id, check_in, check_out, booking_status, payment_status, source, notes
)
select 'LEGACY-202609-01', id, date '2026-09-01', date '2026-09-06', 'confirmed', 'paid', 'operations_sheet', 'Imported from Lombard operations sheet: occupied nights 1-5 September 2026.' from p
union all
select 'LEGACY-202609-09', id, date '2026-09-09', date '2026-09-15', 'confirmed', 'paid', 'operations_sheet', 'Imported from Lombard operations sheet: occupied nights 9-14 September 2026.' from p
union all
select 'LEGACY-202609-18', id, date '2026-09-18', date '2026-09-20', 'confirmed', 'paid', 'operations_sheet', 'Imported from Lombard operations sheet: occupied nights 18-19 September 2026.' from p;

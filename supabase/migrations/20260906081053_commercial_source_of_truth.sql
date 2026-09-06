-- PTM commercial source of truth: foundation stage.
--
-- This migration deliberately does not activate the approved Complete/Flex
-- plans. The deployed v3 Edge Function is not plan-aware; activating both
-- plans before the replacement function is live would make rate selection
-- ambiguous. The paired activation migration is only applied after the new
-- function has passed its smoke tests.

set local search_path = public, extensions, pg_catalog;

-- Keep the customer-facing identity alongside the stable operational property
-- code. The code remains LOMBARD for legacy operational records.
alter table public.ptm_properties
  add column if not exists public_name text,
  add column if not exists operator_name text;

alter table public.ptm_properties
  add constraint ptm_properties_public_name_check
  check (public_name is null or length(trim(public_name)) > 0);

alter table public.ptm_properties
  add constraint ptm_properties_operator_name_check
  check (operator_name is null or length(trim(operator_name)) > 0);

update public.ptm_properties
set
  public_name = coalesce(public_name, 'Cozy Up On 5th'),
  operator_name = coalesce(operator_name, 'PTM Exclusive')
where code = 'LOMBARD';

create table public.ptm_rate_plans (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ptm_properties(id) on delete restrict,
  product_code text not null check (product_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  product_name text not null check (length(trim(product_name)) > 0),
  plan_version integer not null check (plan_version >= 0),
  nightly_rate numeric(12,2) not null check (nightly_rate > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  automatic_discount_enabled boolean not null,
  public_visible boolean not null default false,
  effective_from date,
  effective_to date,
  active boolean not null default false,
  approval_status text not null default 'draft'
    check (approval_status in ('draft', 'approved', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (not active or approval_status = 'approved'),
  unique (property_id, product_code, plan_version)
);

create unique index ptm_rate_plans_one_active_product_idx
  on public.ptm_rate_plans (property_id, product_code)
  where active and approval_status = 'approved';

create index ptm_rate_plans_effective_lookup_idx
  on public.ptm_rate_plans (property_id, product_code, effective_from, effective_to)
  where active and approval_status = 'approved';

create index ptm_rate_plans_public_lookup_idx
  on public.ptm_rate_plans (property_id, product_code, effective_from, effective_to)
  where active and approval_status = 'approved' and public_visible;

create table public.ptm_payment_rails (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ptm_properties(id) on delete restrict,
  rail_code text not null check (rail_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  rail_version integer not null default 1 check (rail_version > 0),
  provider_name text not null check (length(trim(provider_name)) > 0),
  agent_name text not null check (length(trim(agent_name)) > 0),
  agent_code text not null check (agent_code ~ '^[0-9]+$'),
  ussd_prefix text not null check (ussd_prefix ~ '^\*([0-9]+\*)+$'),
  max_transaction_amount numeric(12,2) not null check (max_transaction_amount > 0),
  daily_limit_amount numeric(12,2)
    check (daily_limit_amount is null or daily_limit_amount > 0),
  monthly_limit_amount numeric(12,2)
    check (monthly_limit_amount is null or monthly_limit_amount > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  effective_from date,
  effective_to date,
  active boolean not null default false,
  approval_status text not null default 'draft'
    check (approval_status in ('draft', 'approved', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (not active or approval_status = 'approved'),
  check (
    daily_limit_amount is null
    or monthly_limit_amount is null
    or daily_limit_amount <= monthly_limit_amount
  ),
  unique (property_id, rail_code, rail_version)
);

create unique index ptm_payment_rails_one_active_code_idx
  on public.ptm_payment_rails (property_id, rail_code)
  where active and approval_status = 'approved';

create index ptm_payment_rails_effective_lookup_idx
  on public.ptm_payment_rails (property_id, rail_code, effective_from, effective_to)
  where active and approval_status = 'approved';

alter table public.ptm_rate_plans enable row level security;
alter table public.ptm_payment_rails enable row level security;

create policy "ptm_rate_plans_service_role_only"
on public.ptm_rate_plans
for all to service_role
using (true)
with check (true);

create policy "ptm_payment_rails_service_role_only"
on public.ptm_payment_rails
for all to service_role
using (true)
with check (true);

revoke all on table public.ptm_rate_plans from anon, authenticated;
revoke all on table public.ptm_payment_rails from anon, authenticated;

create trigger ptm_rate_plans_set_updated_at
before update on public.ptm_rate_plans
for each row execute function private.ptm_set_updated_at();

create trigger ptm_payment_rails_set_updated_at
before update on public.ptm_payment_rails
for each row execute function private.ptm_set_updated_at();

-- Existing production rules remain live through this foundation migration.
-- They are grouped under a version-zero legacy plan so the later Edge Function
-- can select a plan deterministically without rewriting historical quotes.
do $$
declare
  lombard_property_id uuid;
  active_rule_count integer;
  expected_legacy_rule_count integer;
begin
  select id into lombard_property_id
  from public.ptm_properties
  where code = 'LOMBARD'
  for update;

  if lombard_property_id is null then
    raise exception 'PTM commercial migration requires property code LOMBARD';
  end if;

  select count(*) into active_rule_count
  from public.ptm_pricing_rules
  where property_id = lombard_property_id
    and active
    and approval_status = 'approved';

  select count(*) into expected_legacy_rule_count
  from public.ptm_pricing_rules
  where property_id = lombard_property_id
    and active
    and approval_status = 'approved'
    and (
      (nightly_rate = 65.00 and min_nights = 1 and max_nights = 6 and discount_percent = 0.00)
      or (nightly_rate = 65.00 and min_nights = 7 and max_nights = 13 and discount_percent = 5.00)
      or (nightly_rate = 65.00 and min_nights = 14 and max_nights = 29 and discount_percent = 10.00)
      or (nightly_rate = 65.00 and min_nights = 30 and max_nights is null and discount_percent = 35.00)
    );

  if active_rule_count <> 4 or expected_legacy_rule_count <> 4 then
    raise exception
      'PTM commercial migration stopped: expected exactly four active approved legacy $65 rules for LOMBARD, found % active / % expected',
      active_rule_count,
      expected_legacy_rule_count;
  end if;
end;
$$;

insert into public.ptm_rate_plans (
  property_id, product_code, product_name, plan_version, nightly_rate, currency,
  automatic_discount_enabled, public_visible, active, approval_status
)
select id, 'complete', 'Complete Package (Legacy)', 0, 65.00, currency, true, false, true, 'approved'
from public.ptm_properties
where code = 'LOMBARD'
on conflict (property_id, product_code, plan_version) do nothing;

alter table public.ptm_pricing_rules
  add column rate_plan_id uuid references public.ptm_rate_plans(id) on delete restrict,
  add column rule_code text;

with legacy_plan as (
  select id, property_id
  from public.ptm_rate_plans
  where product_code = 'complete'
    and plan_version = 0
)
update public.ptm_pricing_rules rule
set
  rate_plan_id = legacy_plan.id,
  rule_code = case
    when rule.min_nights = 1 then 'legacy_complete_1_6'
    when rule.min_nights = 7 then 'legacy_complete_7_13'
    when rule.min_nights = 14 then 'legacy_complete_14_29'
    else 'legacy_complete_30_plus'
  end
from legacy_plan
where rule.property_id = legacy_plan.property_id
  and rule.active
  and rule.approval_status = 'approved'
  and rule.nightly_rate = 65.00
  and (
    (rule.min_nights = 1 and rule.max_nights = 6 and rule.discount_percent = 0.00)
    or (rule.min_nights = 7 and rule.max_nights = 13 and rule.discount_percent = 5.00)
    or (rule.min_nights = 14 and rule.max_nights = 29 and rule.discount_percent = 10.00)
    or (rule.min_nights = 30 and rule.max_nights is null and rule.discount_percent = 35.00)
  );

alter table public.ptm_pricing_rules
  alter column rate_plan_id set not null,
  alter column rule_code set not null;

create unique index ptm_pricing_rules_plan_rule_code_idx
  on public.ptm_pricing_rules (rate_plan_id, rule_code);

create index ptm_pricing_rules_active_plan_lookup_idx
  on public.ptm_pricing_rules (rate_plan_id, min_nights desc, max_nights)
  where active and approval_status = 'approved';

create or replace function private.ptm_validate_pricing_rule_rate_plan()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  plan record;
begin
  select
    id,
    property_id,
    nightly_rate,
    automatic_discount_enabled,
    active,
    approval_status
  into plan
  from public.ptm_rate_plans
  where id = new.rate_plan_id;

  if not found then
    raise exception 'Pricing rule must reference an existing rate plan';
  end if;

  if new.property_id <> plan.property_id then
    raise exception 'Pricing rule property must match its rate plan';
  end if;

  if new.nightly_rate <> plan.nightly_rate then
    raise exception 'Pricing rule nightly rate must match its rate plan';
  end if;

  if not plan.automatic_discount_enabled and new.discount_percent <> 0 then
    raise exception 'A rate plan without automatic discounts cannot have a discounted pricing rule';
  end if;

  if new.active and new.approval_status <> 'approved' then
    raise exception 'An active pricing rule must be approved';
  end if;

  if new.active and (not plan.active or plan.approval_status <> 'approved') then
    raise exception 'An active pricing rule requires an active approved rate plan';
  end if;

  return new;
end;
$$;

revoke all on function private.ptm_validate_pricing_rule_rate_plan() from public;

create trigger ptm_pricing_rules_validate_rate_plan
before insert or update of
  property_id,
  rate_plan_id,
  nightly_rate,
  discount_percent,
  active,
  approval_status
on public.ptm_pricing_rules
for each row execute function private.ptm_validate_pricing_rule_rate_plan();

alter table public.ptm_pricing_rules
  add constraint ptm_pricing_rules_no_active_overlap
  exclude using gist (
    rate_plan_id with =,
    int8range(
      min_nights::bigint,
      case when max_nights is null then null else max_nights::bigint + 1 end,
      '[)'
    ) with &&,
    daterange(
      coalesce(effective_from, '-infinity'::date),
      case when effective_to is null then 'infinity'::date else effective_to + 1 end,
      '[)'
    ) with &&
  )
  where (active and approval_status = 'approved');

-- The two historical official quotes retain their original snapshots but are
-- explicitly marked unresolved. They predate plan/rule lineage, so no
-- retrospective relationship is fabricated.
alter table public.ptm_quotes
  add column rate_plan_id uuid references public.ptm_rate_plans(id) on delete restrict,
  add column pricing_rule_id uuid references public.ptm_pricing_rules(id) on delete restrict,
  add column rate_plan_code text,
  add column pricing_rule_code text,
  add column pricing_date date,
  add column subtotal_amount numeric(12,2),
  add column discount_amount numeric(12,2),
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column pricing_lineage_status text not null default 'legacy_unresolved'
    check (pricing_lineage_status in ('legacy_unresolved', 'resolved'));

alter table public.ptm_quotes
  add constraint ptm_quotes_nights_dates_check
    check (nights = check_out - check_in),
  add constraint ptm_quotes_amount_parts_check
    check (
      subtotal_amount is null
      or (
        subtotal_amount >= 0
        and discount_amount is not null
        and discount_amount >= 0
        and discount_amount <= subtotal_amount
      )
    ),
  add constraint ptm_quotes_lineage_pair_check
    check (
      (
        pricing_lineage_status = 'legacy_unresolved'
        and rate_plan_id is null
        and pricing_rule_id is null
        and rate_plan_code is null
        and pricing_rule_code is null
        and pricing_date is null
      )
      or (
        pricing_lineage_status = 'resolved'
        and rate_plan_id is not null
        and pricing_rule_id is not null
        and rate_plan_code is not null
        and pricing_rule_code is not null
        and pricing_date is not null
        and subtotal_amount is not null
        and discount_amount is not null
        and currency is not null
        and total_amount = subtotal_amount - discount_amount
      )
    );

create index ptm_quotes_rate_plan_id_idx
  on public.ptm_quotes (rate_plan_id);

create index ptm_quotes_pricing_rule_id_idx
  on public.ptm_quotes (pricing_rule_id);

create or replace function private.ptm_validate_quote_pricing_lineage()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  plan record;
  rule record;
begin
  if new.pricing_lineage_status = 'legacy_unresolved' then
    return new;
  end if;

  select
    id,
    property_id,
    product_code,
    nightly_rate,
    currency,
    active,
    approval_status,
    effective_from,
    effective_to
  into plan
  from public.ptm_rate_plans
  where id = new.rate_plan_id;

  if not found then
    raise exception 'Resolved quote must reference an existing rate plan';
  end if;

  select
    id,
    rate_plan_id,
    rule_code,
    nightly_rate,
    min_nights,
    max_nights,
    discount_percent,
    active,
    approval_status,
    effective_from,
    effective_to
  into rule
  from public.ptm_pricing_rules
  where id = new.pricing_rule_id;

  if not found then
    raise exception 'Resolved quote must reference an existing pricing rule';
  end if;

  if plan.property_id <> new.property_id or rule.rate_plan_id <> plan.id then
    raise exception 'Resolved quote pricing lineage must remain within one property and rate plan';
  end if;

  if new.rate_plan_code <> plan.product_code or new.pricing_rule_code <> rule.rule_code then
    raise exception 'Resolved quote pricing code snapshots must match their referenced records';
  end if;

  if new.currency <> plan.currency
    or new.nightly_rate <> plan.nightly_rate
    or new.nightly_rate <> rule.nightly_rate
    or new.discount_percent <> rule.discount_percent then
    raise exception 'Resolved quote pricing snapshot must match the selected plan and rule';
  end if;

  if new.nights < rule.min_nights
    or (rule.max_nights is not null and new.nights > rule.max_nights) then
    raise exception 'Resolved quote stay does not fit its selected pricing rule';
  end if;

  if not plan.active
    or plan.approval_status <> 'approved'
    or not rule.active
    or rule.approval_status <> 'approved'
    or (plan.effective_from is not null and plan.effective_from > new.pricing_date)
    or (plan.effective_to is not null and plan.effective_to < new.pricing_date)
    or (rule.effective_from is not null and rule.effective_from > new.pricing_date)
    or (rule.effective_to is not null and rule.effective_to < new.pricing_date) then
    raise exception 'Resolved quote must use active approved effective commercial rules';
  end if;

  if new.subtotal_amount <> new.nightly_rate * new.nights
    or new.discount_amount <> round(new.subtotal_amount * new.discount_percent / 100, 2)
    or new.total_amount <> new.subtotal_amount - new.discount_amount then
    raise exception 'Resolved quote amount snapshot is inconsistent with its pricing lineage';
  end if;

  return new;
end;
$$;

revoke all on function private.ptm_validate_quote_pricing_lineage() from public;

create trigger ptm_quotes_validate_pricing_lineage
before insert or update of
  property_id,
  nights,
  nightly_rate,
  discount_percent,
  total_amount,
  rate_plan_id,
  pricing_rule_id,
  rate_plan_code,
  pricing_rule_code,
  pricing_date,
  subtotal_amount,
  discount_amount,
  currency,
  pricing_lineage_status
on public.ptm_quotes
for each row execute function private.ptm_validate_quote_pricing_lineage();

-- Stage the approved product structure. It is stored now but not made live
-- until the plan-aware Edge Function has been deployed.
insert into public.ptm_rate_plans (
  property_id, product_code, product_name, plan_version, nightly_rate, currency,
  automatic_discount_enabled, public_visible, active, approval_status
)
select
  property.id,
  desired.product_code,
  desired.product_name,
  desired.plan_version,
  desired.nightly_rate,
  property.currency,
  desired.automatic_discount_enabled,
  desired.public_visible,
  false,
  'approved'
from public.ptm_properties property
cross join (
  values
    ('complete'::text, 'Complete Package'::text, 1::integer, 70.00::numeric, true, true),
    ('flex'::text, 'Flex Option'::text, 1::integer, 50.00::numeric, false, false)
) as desired(
  product_code,
  product_name,
  plan_version,
  nightly_rate,
  automatic_discount_enabled,
  public_visible
)
where property.code = 'LOMBARD'
on conflict (property_id, product_code, plan_version) do nothing;

with desired_rules as (
  select *
  from (
    values
      ('complete'::text, 1::integer, 'complete_standard_1_6'::text, 'Standard Stay'::text, 1::integer, 6::integer, 0.00::numeric),
      ('complete'::text, 1::integer, 'complete_weekly_7_13'::text, 'Weekly Stay Discount'::text, 7::integer, 13::integer, 5.00::numeric),
      ('complete'::text, 1::integer, 'complete_fortnight_14_20'::text, 'Fortnight Stay Discount'::text, 14::integer, 20::integer, 10.00::numeric),
      ('complete'::text, 1::integer, 'complete_three_week_21_29'::text, 'Three-Week Stay Discount'::text, 21::integer, 29::integer, 15.00::numeric),
      ('complete'::text, 1::integer, 'complete_monthly_30_plus'::text, 'Monthly Stay Discount'::text, 30::integer, null::integer, 20.00::numeric),
      ('flex'::text, 1::integer, 'flex_standard'::text, 'Flex Standard Rate'::text, 1::integer, null::integer, 0.00::numeric)
  ) as values_table(
    product_code,
    plan_version,
    rule_code,
    rule_name,
    min_nights,
    max_nights,
    discount_percent
  )
)
insert into public.ptm_pricing_rules (
  property_id,
  rate_plan_id,
  rule_code,
  rule_name,
  nightly_rate,
  min_nights,
  max_nights,
  discount_percent,
  active,
  approval_status
)
select
  property.id,
  plan.id,
  desired.rule_code,
  desired.rule_name,
  plan.nightly_rate,
  desired.min_nights,
  desired.max_nights,
  desired.discount_percent,
  false,
  'approved'
from desired_rules desired
join public.ptm_properties property on property.code = 'LOMBARD'
join public.ptm_rate_plans plan
  on plan.property_id = property.id
  and plan.product_code = desired.product_code
  and plan.plan_version = desired.plan_version
on conflict (rate_plan_id, rule_code) do nothing;

-- Payment Control v3 configuration. Daily and monthly operating limits stay
-- NULL until a primary-source EcoCash verification authorises values.
insert into public.ptm_payment_rails (
  property_id,
  rail_code,
  rail_version,
  provider_name,
  agent_name,
  agent_code,
  ussd_prefix,
  max_transaction_amount,
  daily_limit_amount,
  monthly_limit_amount,
  currency,
  active,
  approval_status
)
select
  id,
  'ecocash_agent_cash_out',
  1,
  'EcoCash',
  'Natmed',
  '029327',
  '*153*3*1*',
  500.00,
  null,
  null,
  currency,
  true,
  'approved'
from public.ptm_properties
where code = 'LOMBARD'
on conflict (property_id, rail_code, rail_version) do nothing;

-- Resolve existing performance/security advisor findings without exposing the
-- commercial tables through the Data API.
create index if not exists ptm_bookings_quote_id_idx
  on public.ptm_bookings (quote_id);
create index if not exists ptm_campaigns_property_id_idx
  on public.ptm_campaigns (property_id);
create index if not exists ptm_campaigns_pricing_rule_id_idx
  on public.ptm_campaigns (pricing_rule_id);
create index if not exists ptm_campaigns_created_by_idx
  on public.ptm_campaigns (created_by);
create index if not exists ptm_campaign_assets_created_by_idx
  on public.ptm_campaign_assets (created_by);

revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;

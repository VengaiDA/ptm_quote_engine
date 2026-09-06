-- PTM Agent Lite v1.2: Campaigns
-- Campaign records distribute approved PTM offers; they do not calculate pricing.

create schema if not exists private;
revoke all on schema private from public;

create sequence if not exists public.ptm_campaign_code_seq as integer start with 1;

create table public.ptm_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_code text not null unique default (
    'PTM-CMP-' || to_char(current_date, 'YYYYMM') || '-' ||
    lpad(nextval('public.ptm_campaign_code_seq')::text, 3, '0')
  ),
  property_id uuid not null references public.ptm_properties(id) on delete restrict,
  pricing_rule_id uuid references public.ptm_pricing_rules(id) on delete set null,
  title text not null check (length(trim(title)) > 0),
  description text,
  approved_copy text not null default '',
  terms text,
  valid_from date not null default current_date,
  valid_to date,
  always_visible boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_by uuid references public.ptm_agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check ((status <> 'published') or published_at is not null)
);

create table public.ptm_campaign_assets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ptm_campaigns(id) on delete cascade,
  file_name text not null check (length(trim(file_name)) > 0 and position('/' in file_name) = 0),
  storage_path text not null unique,
  asset_type text not null default 'other'
    check (asset_type in ('poster', 'social_image', 'flyer', 'whatsapp_artwork', 'other')),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  upload_status text not null default 'pending' check (upload_status in ('pending', 'ready')),
  uploaded_at timestamptz,
  created_by uuid references public.ptm_agents(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, file_name),
  check (storage_path like campaign_id::text || '/%')
);

create index ptm_campaigns_agent_listing_idx
  on public.ptm_campaigns (status, always_visible, valid_from, valid_to, property_id);
create index ptm_campaign_assets_campaign_idx
  on public.ptm_campaign_assets (campaign_id, created_at);

create or replace function private.ptm_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.ptm_validate_campaign_pricing_rule()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.pricing_rule_id is not null and not exists (
    select 1
    from public.ptm_pricing_rules rule
    where rule.id = new.pricing_rule_id
      and rule.property_id = new.property_id
      and rule.active = true
      and rule.approval_status = 'approved'
  ) then
    raise exception 'Campaign pricing must reference an active approved rule for the same property';
  end if;
  return new;
end;
$$;

revoke all on function private.ptm_set_updated_at() from public;
revoke all on function private.ptm_validate_campaign_pricing_rule() from public;

create trigger ptm_campaigns_set_updated_at
before update on public.ptm_campaigns
for each row execute function private.ptm_set_updated_at();

create trigger ptm_campaigns_validate_pricing_rule
before insert or update of property_id, pricing_rule_id on public.ptm_campaigns
for each row execute function private.ptm_validate_campaign_pricing_rule();

alter table public.ptm_campaigns enable row level security;
alter table public.ptm_campaign_assets enable row level security;

create policy "ptm_campaigns_service_role_only"
on public.ptm_campaigns
for all to service_role
using (true)
with check (true);

create policy "ptm_campaign_assets_service_role_only"
on public.ptm_campaign_assets
for all to service_role
using (true)
with check (true);

-- The Agent Lite frontend uses the authenticated Edge Function, not direct Data API access.
revoke all on table public.ptm_campaigns from anon, authenticated;
revoke all on table public.ptm_campaign_assets from anon, authenticated;
revoke all on sequence public.ptm_campaign_code_seq from anon, authenticated;

-- Private campaign assets are supplied only through short-lived signed URLs generated
-- by the Edge Function after its PTM token and role checks have passed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ptm-campaigns',
  'ptm-campaigns',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated Storage policy is created for this bucket. With Storage RLS
-- enabled, direct browser reads, uploads, updates and deletes are therefore denied.

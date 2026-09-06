-- PTM Agent Lite v1.3: Property Support
-- Operational contact and payment-channel data remains property-scoped and is
-- supplied only through the authenticated Edge Function.

create table public.ptm_property_contacts (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ptm_properties(id) on delete restrict,
  contact_type text not null check (contact_type in ('property_admin', 'caretaker_operations')),
  display_name text not null check (length(trim(display_name)) > 0),
  role_title text not null check (length(trim(role_title)) > 0),
  phone_number text,
  whatsapp_number text check (whatsapp_number is null or whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (contact_type = 'property_admin' and role_title = 'Property Manager / Admin') or
    (contact_type = 'caretaker_operations' and role_title = 'Caretaker / Operations Officer')
  )
);

create table public.ptm_payment_channels (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ptm_properties(id) on delete restrict,
  payment_type text not null check (length(trim(payment_type)) > 0),
  display_name text not null check (length(trim(display_name)) > 0),
  payment_reference text not null check (length(trim(payment_reference)) > 0),
  instructions text,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ptm_property_contacts_active_listing_idx
  on public.ptm_property_contacts (property_id, active, display_order, created_at);
create index ptm_payment_channels_active_listing_idx
  on public.ptm_payment_channels (property_id, active, display_order, created_at);

create trigger ptm_property_contacts_set_updated_at
before update on public.ptm_property_contacts
for each row execute function private.ptm_set_updated_at();

create trigger ptm_payment_channels_set_updated_at
before update on public.ptm_payment_channels
for each row execute function private.ptm_set_updated_at();

alter table public.ptm_property_contacts enable row level security;
alter table public.ptm_payment_channels enable row level security;

create policy "ptm_property_contacts_service_role_only"
on public.ptm_property_contacts
for all to service_role
using (true)
with check (true);

create policy "ptm_payment_channels_service_role_only"
on public.ptm_payment_channels
for all to service_role
using (true)
with check (true);

-- Browsers must never read or mutate these tables directly. The Edge Function
-- applies PTM token authentication and property scoping before returning data.
revoke all on table public.ptm_property_contacts from anon, authenticated;
revoke all on table public.ptm_payment_channels from anon, authenticated;

-- Intentionally no production contact or payment values are seeded here.
-- Approved values must be entered by an authorised PTM admin before release.

-- PTM quote renderer configuration.
--
-- This is deliberately presentation-only. These fields never participate in
-- commercial calculations and nullable terms are omitted by renderers until
-- PTM explicitly approves their values.

create table public.ptm_quote_presentation_settings (
  property_id uuid primary key references public.ptm_properties(id) on delete restrict,
  logo_url text,
  operator_name text check (operator_name is null or length(trim(operator_name)) > 0),
  property_address text,
  contact_phone text,
  contact_email text,
  contact_whatsapp text,
  check_in_time text,
  check_out_time text,
  cancellation_policy text,
  accepted_payment_methods text,
  quote_validity_hours integer check (quote_validity_hours is null or quote_validity_hours > 0),
  booking_confirmation_text text,
  footer_text text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ptm_quote_presentation_settings_set_updated_at
before update on public.ptm_quote_presentation_settings
for each row execute function private.ptm_set_updated_at();

alter table public.ptm_quote_presentation_settings enable row level security;

create policy "ptm_quote_presentation_settings_service_role_only"
on public.ptm_quote_presentation_settings
for all to service_role
using (true)
with check (true);

revoke all on table public.ptm_quote_presentation_settings from anon, authenticated;

insert into public.ptm_quote_presentation_settings (
  property_id,
  operator_name,
  accepted_payment_methods,
  quote_validity_hours,
  booking_confirmation_text,
  footer_text
)
select
  id,
  'PTM Exclusive',
  'Cash and EcoCash payments are available.',
  24,
  'A quotation does not secure the selected dates. Your reservation is confirmed once the required payment has been received. Until payment is received, dates remain subject to availability.',
  'Thank you for choosing PTM Exclusive.'
from public.ptm_properties
where code = 'LOMBARD'
on conflict (property_id) do nothing;

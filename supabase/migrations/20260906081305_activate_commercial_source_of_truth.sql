-- PTM commercial source of truth: activation stage.
--
-- Apply only after the plan-aware ptm-agent-lite Edge Function source in this
-- branch has been deployed and smoke-tested. This migration intentionally
-- makes the old function fail closed: newly inserted quotes must carry
-- resolved plan/rule lineage after this point.

set local search_path = public, extensions, pg_catalog;

do $$
declare
  lombard_property_id uuid;
  legacy_plan_id uuid;
  complete_plan_id uuid;
  flex_plan_id uuid;
  staged_rule_count integer;
begin
  select id into lombard_property_id
  from public.ptm_properties
  where code = 'LOMBARD'
  for update;

  if lombard_property_id is null then
    raise exception 'PTM commercial activation requires property code LOMBARD';
  end if;

  select id into legacy_plan_id
  from public.ptm_rate_plans
  where property_id = lombard_property_id
    and product_code = 'complete'
    and plan_version = 0
    and active
    and approval_status = 'approved'
  for update;

  select id into complete_plan_id
  from public.ptm_rate_plans
  where property_id = lombard_property_id
    and product_code = 'complete'
    and plan_version = 1
    and not active
    and approval_status = 'approved'
  for update;

  select id into flex_plan_id
  from public.ptm_rate_plans
  where property_id = lombard_property_id
    and product_code = 'flex'
    and plan_version = 1
    and not active
    and approval_status = 'approved'
  for update;

  if legacy_plan_id is null or complete_plan_id is null or flex_plan_id is null then
    raise exception 'PTM commercial activation stopped: expected one active legacy plan and staged Complete/Flex v1 plans';
  end if;

  select count(*) into staged_rule_count
  from public.ptm_pricing_rules
  where rate_plan_id in (complete_plan_id, flex_plan_id)
    and not active
    and approval_status = 'approved';

  if staged_rule_count <> 6 then
    raise exception 'PTM commercial activation stopped: expected six staged Complete/Flex rules, found %', staged_rule_count;
  end if;

  if exists (
    select 1
    from public.ptm_campaigns campaign
    join public.ptm_pricing_rules rule on rule.id = campaign.pricing_rule_id
    where campaign.status = 'published'
      and rule.rate_plan_id = legacy_plan_id
  ) then
    raise exception 'PTM commercial activation stopped: a published campaign still references a legacy pricing rule';
  end if;
end;
$$;

-- Retire the legacy policy first so the unique active-product index can safely
-- promote Complete Package v1 in the same transaction.
update public.ptm_pricing_rules
set
  active = false,
  approval_status = 'retired',
  effective_to = current_date - 1
where rate_plan_id = (
  select id
  from public.ptm_rate_plans
  where product_code = 'complete'
    and plan_version = 0
    and property_id = (select id from public.ptm_properties where code = 'LOMBARD')
);

update public.ptm_rate_plans
set
  active = false,
  approval_status = 'retired',
  effective_to = current_date - 1
where product_code = 'complete'
  and plan_version = 0
  and property_id = (select id from public.ptm_properties where code = 'LOMBARD');

update public.ptm_rate_plans
set
  active = true,
  approval_status = 'approved',
  effective_from = current_date,
  effective_to = null
where property_id = (select id from public.ptm_properties where code = 'LOMBARD')
  and (
    (product_code = 'complete' and plan_version = 1)
    or (product_code = 'flex' and plan_version = 1)
  );

update public.ptm_pricing_rules
set
  active = true,
  approval_status = 'approved',
  effective_from = current_date,
  effective_to = null
where rate_plan_id in (
  select id
  from public.ptm_rate_plans
  where property_id = (select id from public.ptm_properties where code = 'LOMBARD')
    and plan_version = 1
    and product_code in ('complete', 'flex')
);

-- After the cutover, an old Edge Function cannot create a silent,
-- unlineaged quote: it will omit required snapshots and the quote constraints
-- will reject the insert.
alter table public.ptm_quotes
  alter column pricing_lineage_status set default 'resolved';

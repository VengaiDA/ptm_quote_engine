# Recovered but not applied

This folder preserves Supabase source recovered from the PTM Agent Lite handoff that is **not recorded in the live project's migration history**.

`20260905000000_ptm_agent_lite_property_support.sql` creates property contacts and generic payment-channel tables. It is retained for review and provenance, but is intentionally outside `supabase/migrations/` so a future `supabase db push` cannot apply it accidentally. Decide explicitly whether it belongs in a future release before generating a new forward-only migration.

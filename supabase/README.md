# PTM Supabase source

This directory is the version-controlled source for the PTM commercial backend.

It contains the production migration history recovered from the PTM Agent Lite handoff, the deployed `ptm-agent-lite` Edge Function source, and forward-only commercial-policy migrations. It is intentionally separate from the static GitHub Pages interfaces.

The recovered property-support migration was not present in the live migration history when this branch was audited. It is preserved under [`recovered-not-applied/`](./recovered-not-applied/) rather than the active migration chain, so it cannot be deployed accidentally.

## Deployment discipline

- Do not rerun an existing production migration.
- Create new migrations with the Supabase CLI and apply them forward-only after review.
- Do not put Supabase service-role keys, agent tokens, payment credentials, or environment files in this repository.
- The Edge Function is the authoritative path for quote and payment decisions; browser applications must not recreate approved pricing or payment rules.

See [the cutover runbook](./DEPLOYMENT.md) for the required foundation → Edge
Function → activation order.

## Current commercial target

- Complete Package: $70/night; automatic tiers at 7/14/21/30 nights for 5/10/15/20%.
- Flex Option: $50/night; no automatic length-of-stay discount.
- EcoCash instructions are derived from a server-side payment rail and an issued `quote_code`, never a client-provided amount.

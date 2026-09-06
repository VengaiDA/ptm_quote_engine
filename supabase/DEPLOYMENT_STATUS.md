# PTM commercial-source-of-truth deployment status

Updated 6 September 2026.

## Applied safely

- `commercial_source_of_truth` is applied to Supabase project
  `frmubomhhnlqrgepmmcm`.
- The migration preserves the active legacy $65 policy while staging the
  approved $70 Complete and $50 Flex plans, quote lineage, and the EcoCash
  payment rail.
- The JWT-protected `ptm-agent-lite-public` Edge Function is deployed at
  version 2. It accepts only the project anonymous key and exposes only
  non-persistent public rate-plan and quote-preview actions.

## Intentionally pending

- `activate_commercial_source_of_truth` is **not** applied. It would make old
  authenticated quote creation fail closed because the legacy function cannot
  write the new immutable pricing lineage.
- The plan-aware replacement for the existing authenticated `ptm-agent-lite`
  function is committed as source but not deployed. Its custom agent-token
  design requires the function gateway's JWT verification to remain disabled.
  That is a production security decision requiring explicit PTM approval, or a
  later migration to Supabase Auth.
- GitHub Pages is not updated to point Agent Lite at the new public API until
  the commercial activation is safely complete. This prevents a public page
  from reaching a deliberately staged, inactive price plan.

## Verified evidence

- Shared pricing and payment tests: 8/8 pass.
- The public Edge Function rejects missing authorization at the gateway with
  HTTP 401.
- With a valid anonymous key, it reaches the handler and currently reports no
  public rate plan (HTTP 503), as expected before activation.

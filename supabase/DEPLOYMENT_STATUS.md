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
- The authenticated `ptm-agent-lite` replacement is deployed at version 4 with
  `verify_jwt = false`, under PTM's explicitly approved custom-agent-token
  boundary. Its duplicate unauthenticated preview routes were removed; every
  remaining action passes through `authAgent` before it can access property,
  quote, booking, payment, campaign, or admin data.

## Intentionally pending

- `activate_commercial_source_of_truth` is **not** applied. The replacement
  function is deployed, but Gate A remains incomplete until a valid, scoped
  agent credential is supplied for the required positive-authentication,
  role-boundary, quote, payment-plan, and booking smoke tests.
- GitHub Pages is not updated to point Agent Lite at the new public API until
  the commercial activation is safely complete. This prevents a public page
  from reaching a deliberately staged, inactive price plan.

## Verified evidence

- Shared pricing and payment tests: 8/8 pass.
- Negative authentication smoke tests: missing credentials, invalid agent code,
  and invalid token each return the same generic HTTP 401 response.
- The public Edge Function rejects missing authorization at the gateway with
  HTTP 401.
- With a valid anonymous key, it reaches the handler and currently reports no
  public rate plan (HTTP 503), as expected before activation.

# PTM commercial-source-of-truth deployment status

Updated 6 September 2026.

## Applied safely

- `commercial_source_of_truth`, `activate_commercial_source_of_truth`, and
  `quote_presentation_configuration` are applied to Supabase project
  `frmubomhhnlqrgepmmcm`.
- The live commercial policy is Complete Package at $70/night with 5/10/15/20%
  tiers at 7/14/21/30 nights, plus internal Flex Option at $50/night with no
  automatic stay discount. Historical legacy records remain retained.
- The JWT-protected `ptm-agent-lite-public` Edge Function is deployed at
  version 2. It accepts only the project anonymous key and exposes only
  non-persistent public rate-plan and quote-preview actions.
- The authenticated `ptm-agent-lite` replacement is deployed at version 4 with
  `verify_jwt = false`, under PTM's explicitly approved custom-agent-token
  boundary. Its duplicate unauthenticated preview routes were removed; every
  remaining action passes through `authAgent` before it can access property,
  quote, booking, payment, campaign, or admin data.

## Gate A evidence

- Missing credentials, invalid agent code, and invalid token each returned the
  same generic HTTP 401 response.
- Dedicated high-entropy UAT Agent and UAT Admin identities completed positive
  login, agent/admin role-boundary, campaign, availability, official quote,
  quote-derived payment-plan, booking, and collision tests.
- The UAT booking holds were cancelled. Both UAT identities are now inactive
  and their credential rows have been deleted; post-revocation login attempts
  return HTTP 401. Plaintext UAT tokens were never committed or documented.
- Backend regression issued resolved-lineage UAT quotes for every approved
  Complete and Flex discount boundary. Payment plans were balanced for $70,
  $500, $798, $1,000, $1,487.50, and $1,904; the shared test suite also covers
  $501 exactly as $500 plus $1.

## Intentionally pending

- GitHub Pages is not updated to point Agent Lite at the new public API until
  the next presentation function deployment and browser verification are
  safely complete.
- Source includes an authenticated Edge Function update which turns the
  centrally configured 24-hour quotation validity into `expires_at` and
  returns structured renderer fields. It is staged but not yet deployed: the
  deployment safeguard requires a fresh explicit approval for that new
  `verify_jwt = false` function version.

## Verified evidence

- Shared pricing and payment tests: 8/8 pass.
- Negative authentication smoke tests: missing credentials, invalid agent code,
  and invalid token each return the same generic HTTP 401 response.
- The public Edge Function rejects missing authorization at the gateway with
  HTTP 401.
- With a valid anonymous key, the public function returns exactly one public
  rate plan, Complete Package at $70, and a server-calculated $70 preview.
- Presentation settings hold the approved direct-booking check-in, check-out,
  cancellation, payment, 24-hour validity, booking-confirmation, and footer
  wording. Contact and address values remain intentionally unset.

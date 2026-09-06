# PTM commercial cutover runbook

Run this in the listed order. The foundation migration intentionally leaves the
legacy $65 policy active until the plan-aware function is deployed.

1. Confirm the live project migration history still ends at
   **20260903061032_ptm_agent_lite_campaigns** and that **LOMBARD** is the Cozy Up
   On 5th property.
2. Apply **20260906081053_commercial_source_of_truth**. It preserves legacy
   rules, stages Complete v1 / Flex v1, adds quote lineage, and creates the
   active EcoCash rail.
3. Deploy **ptm-agent-lite** with the shared quote and payment modules. Test
   authenticated legacy Complete quotes, ensure they store resolved lineage,
   and test the public preview routes without persistence. The current legacy
   function uses custom agent credentials and has gateway JWT verification
   disabled; do not replace it until PTM explicitly approves that deployment
   posture or a Supabase Auth migration is complete.
4. Apply **20260906081305_activate_commercial_source_of_truth**. It retires the
   old $65 / 35% rules, activates $70 Complete and $50 Flex, and makes
   unlineaged quote inserts fail closed.
5. Apply **20260906130505_quote_presentation_configuration** to install the
   renderer configuration hooks. Do not fill nullable contacts, address,
   check-in/out, cancellation, or unverified payment limits until PTM approves
   them.
6. Deploy the separate **ptm-agent-lite-public** endpoint with gateway JWT
   verification enabled, then test the current public Agent Lite PWA. It must receive backend-calculated
   Complete pricing only; Flex is deliberately not public-visible.

Do not use Supabase database push against this project until the remote
migration history has been reconciled: the recovered property-support SQL is
intentionally kept outside the active migration chain.

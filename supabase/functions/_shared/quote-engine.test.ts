import {
  calculateQuotePricing,
  selectEffectivePricingRule,
  type ApprovedPricingRule,
  type ApprovedRatePlan,
} from './quote-engine.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  assert(
    Object.is(actual, expected),
    message + ': expected ' + String(expected) + ', received ' + String(actual),
  );
}

const completePlan: ApprovedRatePlan = {
  id: 'plan-complete',
  code: 'COMPLETE',
  name: 'Complete Package',
  nightlyRateCents: 7_000,
  active: true,
  approvalStatus: 'approved',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
};

const flexPlan: ApprovedRatePlan = {
  id: 'plan-flex',
  code: 'FLEX',
  name: 'Flex Option',
  nightlyRateCents: 5_000,
  active: true,
  approvalStatus: 'approved',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
};

const approvedRules: ApprovedPricingRule[] = [
  {
    id: 'complete-standard',
    ratePlanId: completePlan.id,
    code: 'COMPLETE_1_6',
    label: 'Standard Stay',
    minimumNights: 1,
    maximumNights: 6,
    discountBasisPoints: 0,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
  {
    id: 'complete-weekly',
    ratePlanId: completePlan.id,
    code: 'COMPLETE_7_13',
    label: 'Weekly Stay Discount',
    minimumNights: 7,
    maximumNights: 13,
    discountBasisPoints: 500,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
  {
    id: 'complete-fortnight',
    ratePlanId: completePlan.id,
    code: 'COMPLETE_14_20',
    label: 'Fortnight Stay Discount',
    minimumNights: 14,
    maximumNights: 20,
    discountBasisPoints: 1_000,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
  {
    id: 'complete-three-week',
    ratePlanId: completePlan.id,
    code: 'COMPLETE_21_29',
    label: 'Three-Week Stay Discount',
    minimumNights: 21,
    maximumNights: 29,
    discountBasisPoints: 1_500,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
  {
    id: 'complete-monthly',
    ratePlanId: completePlan.id,
    code: 'COMPLETE_30_PLUS',
    label: 'Monthly Stay Discount',
    minimumNights: 30,
    maximumNights: null,
    discountBasisPoints: 2_000,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
  {
    id: 'flex-standard',
    ratePlanId: flexPlan.id,
    code: 'FLEX_STANDARD',
    label: 'Flex Standard Rate',
    minimumNights: 1,
    maximumNights: null,
    discountBasisPoints: 0,
    active: true,
    approvalStatus: 'approved',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
  },
];

function quoteFor(plan: ApprovedRatePlan, nights: number) {
  return calculateQuotePricing({
    ratePlan: plan,
    pricingRules: approvedRules,
    nights,
    pricingDate: '2026-09-06',
  });
}

Deno.test('Complete Package applies the approved $70 discount boundaries', () => {
  const cases = [
    { nights: 1, rule: 'COMPLETE_1_6', discount: 0, total: 7_000 },
    { nights: 6, rule: 'COMPLETE_1_6', discount: 0, total: 42_000 },
    { nights: 7, rule: 'COMPLETE_7_13', discount: 2_450, total: 46_550 },
    { nights: 13, rule: 'COMPLETE_7_13', discount: 4_550, total: 86_450 },
    { nights: 14, rule: 'COMPLETE_14_20', discount: 9_800, total: 88_200 },
    { nights: 20, rule: 'COMPLETE_14_20', discount: 14_000, total: 126_000 },
    { nights: 21, rule: 'COMPLETE_21_29', discount: 22_050, total: 124_950 },
    { nights: 29, rule: 'COMPLETE_21_29', discount: 30_450, total: 172_550 },
    { nights: 30, rule: 'COMPLETE_30_PLUS', discount: 42_000, total: 168_000 },
  ];

  for (const testCase of cases) {
    const quote = quoteFor(completePlan, testCase.nights);
    assertEquals(quote.nightlyRateCents, 7_000, String(testCase.nights) + ' nights rate');
    assertEquals(quote.pricingRule.code, testCase.rule, String(testCase.nights) + ' nights rule');
    assertEquals(quote.discountCents, testCase.discount, String(testCase.nights) + ' nights discount');
    assertEquals(quote.accommodationTotalCents, testCase.total, String(testCase.nights) + ' nights total');
    assertEquals(quote.lineage.ratePlanId, completePlan.id, String(testCase.nights) + ' nights plan lineage');
    assertEquals(quote.lineage.pricingRuleId, quote.pricingRule.id, String(testCase.nights) + ' nights rule lineage');
  }
});

Deno.test('Flex Option remains $50 with no automatic discount ladder', () => {
  const oneNight = quoteFor(flexPlan, 1);
  const thirtyNights = quoteFor(flexPlan, 30);
  assertEquals(oneNight.nightlyRateCents, 5_000, 'Flex nightly rate');
  assertEquals(oneNight.discountCents, 0, 'Flex one-night discount');
  assertEquals(oneNight.accommodationTotalCents, 5_000, 'Flex one-night total');
  assertEquals(thirtyNights.pricingRule.code, 'FLEX_STANDARD', 'Flex rule');
  assertEquals(thirtyNights.discountCents, 0, 'Flex thirty-night discount');
  assertEquals(thirtyNights.accommodationTotalCents, 150_000, 'Flex thirty-night total');
});

Deno.test('stale rules are not selected and ambiguous current rules fail closed', () => {
  const staleRule: ApprovedPricingRule = {
    ...approvedRules[0],
    id: 'legacy-complete-standard',
    code: 'LEGACY_65',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-08-31',
  };
  const selected = selectEffectivePricingRule({
    ratePlan: completePlan,
    pricingRules: [staleRule, ...approvedRules],
    nights: 1,
    pricingDate: '2026-09-06',
  });
  assertEquals(selected.pricingRule.id, 'complete-standard', 'Current rule after stale rule retirement');

  let failure = '';
  try {
    selectEffectivePricingRule({
      ratePlan: completePlan,
      pricingRules: [
        ...approvedRules,
        {
          ...approvedRules[0],
          id: 'overlapping-current-rule',
          code: 'OVERLAP',
        },
      ],
      nights: 1,
      pricingDate: '2026-09-06',
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  assert(failure.includes('Multiple approved pricing rules'), 'Ambiguous active rules must fail closed');
});

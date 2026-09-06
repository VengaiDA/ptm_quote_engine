import {
  buildPaymentPlan,
  type ApprovedPaymentRail,
  type ServerResolvedQuote,
} from './payment-control.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  assert(
    Object.is(actual, expected),
    message + ': expected ' + String(expected) + ', received ' + String(actual),
  );
}

const ecocashRail: ApprovedPaymentRail = {
  id: 'rail-ecocash',
  code: 'ECOCASH',
  provider: 'EcoCash',
  agentName: 'Natmed',
  agentCode: '029327',
  ussdPrefix: '*153*3*1*',
  maxTransactionCents: 50_000,
  dailyLimitCents: null,
  monthlyLimitCents: null,
  active: true,
  approvalStatus: 'approved',
};

function quote(amountRequiredCents: number): ServerResolvedQuote {
  return {
    quoteCode: 'PTM-Q-20260906-TEST',
    amountRequiredCents,
    currency: 'USD',
    currencySymbol: '$',
  };
}

function planFor(amountRequiredCents: number) {
  return buildPaymentPlan({ quote: quote(amountRequiredCents), rail: ecocashRail });
}

Deno.test('$70 produces raw single-transaction USSD exactly', () => {
  const plan = planFor(7_000);
  assertEquals(plan.mode, 'single', 'Payment mode');
  assertEquals(plan.transactionCount, 1, 'Transaction count');
  assertEquals(plan.clipboardKind, 'ussd', 'Clipboard kind');
  assertEquals(plan.clipboardText, '*153*3*1*029327*70#', 'Raw USSD');
  assert(plan.isBalanced && plan.isReady, 'Single payment must be ready and balanced');
});

Deno.test('$500 remains one transaction and $501 auto-splits $500 plus $1', () => {
  const atLimit = planFor(50_000);
  assertEquals(atLimit.mode, 'single', '$500 mode');
  assertEquals(atLimit.clipboardText, '*153*3*1*029327*500#', '$500 USSD');

  const overLimit = planFor(50_100);
  assertEquals(overLimit.mode, 'split', '$501 mode');
  assertEquals(overLimit.transactions.length, 2, '$501 count');
  assertEquals(overLimit.transactions[0].amountCents, 50_000, '$501 first amount');
  assertEquals(overLimit.transactions[1].amountCents, 100, '$501 second amount');
  assertEquals(overLimit.clipboardKind, 'payment_instructions', '$501 clipboard kind');
  assert(overLimit.clipboardText?.includes('*153*3*1*029327*500#'), '$501 first USSD');
  assert(overLimit.clipboardText?.includes('*153*3*1*029327*1#'), '$501 second USSD');
});

Deno.test('$798, $1,000, $1,487.50, and $1,904 split exactly in integer cents', () => {
  const cases = [
    { amount: 79_800, expected: [50_000, 29_800] },
    { amount: 100_000, expected: [50_000, 50_000] },
    { amount: 148_750, expected: [50_000, 50_000, 48_750] },
    { amount: 190_400, expected: [50_000, 50_000, 50_000, 40_400] },
  ];

  for (const testCase of cases) {
    const plan = planFor(testCase.amount);
    assertEquals(plan.mode, 'split', String(testCase.amount) + ' mode');
    assertEquals(plan.transactions.length, testCase.expected.length, String(testCase.amount) + ' count');
    assertEquals(
      plan.transactions.map((transaction) => transaction.amountCents).join(','),
      testCase.expected.join(','),
      String(testCase.amount) + ' components',
    );
    assertEquals(
      plan.transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0),
      testCase.amount,
      String(testCase.amount) + ' exact total',
    );
    assert(plan.isBalanced && plan.isReady, String(testCase.amount) + ' must be ready and balanced');
  }
});

Deno.test('split instructions contain every required payment control detail', () => {
  const plan = planFor(88_200);
  assertEquals(plan.clipboardKind, 'payment_instructions', 'Clipboard kind');
  assertEquals(
    plan.clipboardText,
    [
      'Please pay $882 via EcoCash Agent Cash-Out.',
      'Agent Name: Natmed',
      'Agent Code: 029327',
      'Maximum payment per transaction: $500 per transaction.',
      'Please complete the following transactions:',
      '1. $500',
      '*153*3*1*029327*500#',
      '2. $382',
      '*153*3*1*029327*382#',
      'Total payment: $882',
      'Please ensure all transactions are completed.',
    ].join('\n'),
    'Exact $882 instruction payload',
  );
});

Deno.test('invalid or unavailable input cannot produce a clipboard payment', () => {
  const zeroAmount = planFor(0);
  assertEquals(zeroAmount.mode, 'invalid', 'Zero amount mode');
  assertEquals(zeroAmount.clipboardText, null, 'Zero amount clipboard');

  const unavailableRail = buildPaymentPlan({
    quote: quote(7_000),
    rail: { ...ecocashRail, active: false },
  });
  assertEquals(unavailableRail.mode, 'invalid', 'Unavailable rail mode');
  assertEquals(unavailableRail.clipboardText, null, 'Unavailable rail clipboard');

  const dailyLimitedRail = { ...ecocashRail, dailyLimitCents: 7_000 };
  const dailyLimitedPlan = buildPaymentPlan({ quote: quote(7_001), rail: dailyLimitedRail });
  assertEquals(dailyLimitedPlan.mode, 'invalid', 'Configured daily limit mode');
  assertEquals(
    dailyLimitedPlan.reason,
    'The payment amount exceeds the configured daily limit',
    'Configured daily limit reason',
  );
});

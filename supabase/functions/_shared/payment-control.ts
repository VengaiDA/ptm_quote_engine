/**
 * Pure Payment Control v3 planner.
 *
 * The caller must obtain the quote amount from the server by quote code before
 * calling this module. No amount supplied by a browser should be trusted as
 * the source of a payment plan.
 */

export type PaymentPlanMode = 'invalid' | 'single' | 'split';
export type PaymentClipboardKind = 'ussd' | 'payment_instructions' | null;

export interface ServerResolvedQuote {
  quoteCode: string;
  amountRequiredCents: number;
  currency: string;
  currencySymbol: string;
}

export interface ApprovedPaymentRail {
  id: string;
  code: string;
  provider: string;
  agentName: string;
  agentCode: string;
  ussdPrefix: string;
  maxTransactionCents: number;
  /**
   * These remain nullable until a primary-source operating limit is verified.
   * A configured limit is enforced; an unknown limit is never invented.
   */
  dailyLimitCents: number | null;
  monthlyLimitCents: number | null;
  active: boolean;
  approvalStatus: string;
}

export interface PaymentTransaction {
  sequence: number;
  amountCents: number;
  ussd: string;
}

export interface PaymentPlan {
  quoteCode: string;
  paymentRailId: string;
  paymentRailCode: string;
  provider: string;
  agentName: string;
  agentCode: string;
  totalCents: number;
  maxTransactionCents: number;
  transactionCount: number;
  transactions: PaymentTransaction[];
  mode: PaymentPlanMode;
  isBalanced: boolean;
  isReady: boolean;
  reason: string | null;
  clipboardKind: PaymentClipboardKind;
  clipboardText: string | null;
}

export interface PaymentPlanInput {
  quote: ServerResolvedQuote;
  rail: ApprovedPaymentRail;
}

const MAX_TRANSACTION_COUNT = 1_000;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isApproved(status: string): boolean {
  return status.trim().toLowerCase() === 'approved';
}

function validOptionalLimit(value: number | null): boolean {
  return value === null || safePositiveInteger(value) !== null;
}

function validUssdConfiguration(rail: ApprovedPaymentRail): boolean {
  return (
    /^\*(?:\d+\*)+$/.test(cleanText(rail.ussdPrefix)) &&
    /^\d+$/.test(cleanText(rail.agentCode))
  );
}

function invalidPlan(input: PaymentPlanInput, reason: string): PaymentPlan {
  return {
    quoteCode: cleanText(input.quote?.quoteCode),
    paymentRailId: cleanText(input.rail?.id),
    paymentRailCode: cleanText(input.rail?.code),
    provider: cleanText(input.rail?.provider),
    agentName: cleanText(input.rail?.agentName),
    agentCode: cleanText(input.rail?.agentCode),
    totalCents: 0,
    maxTransactionCents: safePositiveInteger(input.rail?.maxTransactionCents) || 0,
    transactionCount: 0,
    transactions: [],
    mode: 'invalid',
    isBalanced: false,
    isReady: false,
    reason,
    clipboardKind: null,
    clipboardText: null,
  };
}

export function formatPaymentAmount(cents: number, currencySymbol: string): string {
  const safeCents = safePositiveInteger(cents);
  if (!safeCents) throw new Error('Payment amount must be a positive safe integer');
  const whole = Math.floor(safeCents / 100);
  const fraction = safeCents % 100;
  return cleanText(currencySymbol) + String(whole) + (
    fraction ? '.' + String(fraction).padStart(2, '0') : ''
  );
}

export function centsToUssdAmount(cents: number): string {
  const safeCents = safePositiveInteger(cents);
  if (!safeCents) throw new Error('USSD amount must be a positive safe integer');
  const whole = Math.floor(safeCents / 100);
  const fraction = safeCents % 100;
  return String(whole) + (fraction ? '.' + String(fraction).padStart(2, '0') : '');
}

export function buildPaymentUssd(rail: ApprovedPaymentRail, amountCents: number): string {
  if (!validUssdConfiguration(rail)) {
    throw new Error('Payment rail USSD configuration is invalid');
  }
  return cleanText(rail.ussdPrefix) + cleanText(rail.agentCode) + '*' +
    centsToUssdAmount(amountCents) + '#';
}

export function buildPaymentInstructions(
  plan: PaymentPlan,
  currencySymbol: string,
): string {
  if (plan.mode !== 'split' || !plan.isReady) {
    throw new Error('Payment instructions require a ready split payment plan');
  }
  return [
    'Please pay ' + formatPaymentAmount(plan.totalCents, currencySymbol) +
      ' via ' + plan.provider + ' Agent Cash-Out.',
    'Agent Name: ' + plan.agentName,
    'Agent Code: ' + plan.agentCode,
    'Maximum payment per transaction: ' + formatPaymentAmount(plan.maxTransactionCents, currencySymbol) +
      ' per transaction.',
    'Please complete the following transactions:',
    ...plan.transactions.flatMap((transaction) => [
      String(transaction.sequence) + '. ' + formatPaymentAmount(transaction.amountCents, currencySymbol),
      transaction.ussd,
    ]),
    'Total payment: ' + formatPaymentAmount(plan.totalCents, currencySymbol),
    'Please ensure all transactions are completed.',
  ].join('\n');
}

/**
 * Creates a balanced one-or-many transaction plan from a server-resolved
 * official quote. A single transaction exposes raw USSD only; a split quote
 * exposes one complete customer-ready instruction payload.
 */
export function buildPaymentPlan(input: PaymentPlanInput): PaymentPlan {
  const quoteCode = cleanText(input.quote?.quoteCode);
  const totalCents = safePositiveInteger(input.quote?.amountRequiredCents);
  const currency = cleanText(input.quote?.currency);
  const currencySymbol = cleanText(input.quote?.currencySymbol);

  if (!quoteCode || !totalCents || !currency || !currencySymbol) {
    return invalidPlan(input, 'A valid server-resolved quote is required');
  }
  if (
    !input.rail?.active ||
    !isApproved(input.rail.approvalStatus || '') ||
    !cleanText(input.rail.id) ||
    !cleanText(input.rail.code) ||
    !cleanText(input.rail.provider) ||
    !cleanText(input.rail.agentName) ||
    !validUssdConfiguration(input.rail)
  ) {
    return invalidPlan(input, 'The configured payment rail is unavailable');
  }

  const maxTransactionCents = safePositiveInteger(input.rail.maxTransactionCents);
  if (!maxTransactionCents) {
    return invalidPlan(input, 'The payment rail transaction limit is invalid');
  }
  if (
    !validOptionalLimit(input.rail.dailyLimitCents) ||
    !validOptionalLimit(input.rail.monthlyLimitCents)
  ) {
    return invalidPlan(input, 'The payment rail optional limits are invalid');
  }
  if (input.rail.dailyLimitCents !== null && totalCents > input.rail.dailyLimitCents) {
    return invalidPlan(input, 'The payment amount exceeds the configured daily limit');
  }
  if (input.rail.monthlyLimitCents !== null && totalCents > input.rail.monthlyLimitCents) {
    return invalidPlan(input, 'The payment amount exceeds the configured monthly limit');
  }

  const transactionCount = Math.ceil(totalCents / maxTransactionCents);
  if (transactionCount > MAX_TRANSACTION_COUNT) {
    return invalidPlan(input, 'The payment plan exceeds the supported transaction count');
  }

  const transactions: PaymentTransaction[] = [];
  let remainingCents = totalCents;
  for (let sequence = 1; remainingCents > 0; sequence += 1) {
    const amountCents = Math.min(remainingCents, maxTransactionCents);
    transactions.push({
      sequence,
      amountCents,
      ussd: buildPaymentUssd(input.rail, amountCents),
    });
    remainingCents -= amountCents;
  }

  const plannedCents = transactions.reduce(
    (sum, transaction) => sum + transaction.amountCents,
    0,
  );
  const isBalanced = plannedCents === totalCents;
  const mode: PaymentPlanMode = transactions.length === 1 ? 'single' : 'split';
  const isReady = isBalanced && transactions.every((transaction) => Boolean(transaction.ussd));
  const basePlan: PaymentPlan = {
    quoteCode,
    paymentRailId: cleanText(input.rail.id),
    paymentRailCode: cleanText(input.rail.code),
    provider: cleanText(input.rail.provider),
    agentName: cleanText(input.rail.agentName),
    agentCode: cleanText(input.rail.agentCode),
    totalCents,
    maxTransactionCents,
    transactionCount: transactions.length,
    transactions,
    mode,
    isBalanced,
    isReady,
    reason: isReady ? null : 'The payment plan is not balanced',
    clipboardKind: null,
    clipboardText: null,
  };

  if (!isReady) return basePlan;
  if (mode === 'single') {
    return {
      ...basePlan,
      clipboardKind: 'ussd',
      clipboardText: transactions[0].ussd,
    };
  }
  return {
    ...basePlan,
    clipboardKind: 'payment_instructions',
    clipboardText: buildPaymentInstructions(basePlan, currencySymbol),
  };
}

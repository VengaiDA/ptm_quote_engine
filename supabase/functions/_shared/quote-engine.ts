/**
 * Pure, server-side quote pricing primitives for PTM.
 *
 * Commercial policy is intentionally supplied as approved rate-plan and
 * pricing-rule records. This module has no browser configuration, database
 * client, or fallback price ladder: the caller must pass the persisted
 * commercial truth it intends to use.
 */

export type DecimalInput = number | string;

export const BASIS_POINTS_PER_PERCENT = 100;
export const FULL_PERCENTAGE_BASIS_POINTS = 10_000;

export interface ApprovedRatePlan {
  id: string;
  code: string;
  name: string;
  nightlyRateCents: number;
  active: boolean;
  approvalStatus: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface ApprovedPricingRule {
  id: string;
  ratePlanId: string;
  code: string;
  label: string;
  minimumNights: number;
  maximumNights: number | null;
  discountBasisPoints: number;
  active: boolean;
  approvalStatus: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface EffectiveRuleSelectionInput {
  ratePlan: ApprovedRatePlan;
  pricingRules: readonly ApprovedPricingRule[];
  nights: number;
  /**
   * Explicitly supplied by the caller. A pricing calculation must never
   * silently choose a wall-clock date when determining which rule is live.
   */
  pricingDate: string;
}

export interface EffectiveRuleSelection {
  ratePlan: ApprovedRatePlan;
  pricingRule: ApprovedPricingRule;
  pricingDate: string;
}

export interface QuotePricing {
  nights: number;
  nightlyRateCents: number;
  accommodationSubtotalCents: number;
  discountCents: number;
  accommodationTotalCents: number;
  discountBasisPoints: number;
  discountLabel: string;
  ratePlan: {
    id: string;
    code: string;
    name: string;
  };
  pricingRule: {
    id: string;
    code: string;
    label: string;
    minimumNights: number;
    maximumNights: number | null;
    discountBasisPoints: number;
  };
  /**
   * Persist these values with the official quote. They make the commercial
   * decision traceable even after later rules become active.
   */
  lineage: {
    ratePlanId: string;
    ratePlanCode: string;
    pricingRuleId: string;
    pricingRuleCode: string;
    pricingDate: string;
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(message: string): never {
  throw new Error(message);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return fail(label + ' is required');
  }
  return value.trim();
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(label + ' must be a non-negative safe integer');
  }
  return Number(value);
}

function safePositiveInteger(value: unknown, label: string): number {
  const parsed = safeNonNegativeInteger(value, label);
  if (parsed < 1) {
    return fail(label + ' must be greater than zero');
  }
  return parsed;
}

function safeMultiply(left: number, right: number, label: string): number {
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    return fail(label + ' exceeds safe integer precision');
  }
  return left * right;
}

function roundHalfUp(numerator: number, divisor: number, label: string): number {
  if (numerator > Number.MAX_SAFE_INTEGER - Math.floor(divisor / 2)) {
    return fail(label + ' exceeds safe integer precision');
  }
  return Math.floor((numerator + Math.floor(divisor / 2)) / divisor);
}

function assertIsoDate(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return fail(label + ' must be an ISO calendar date');
  }
  const match = ISO_DATE.exec(value);
  if (!match) {
    return fail(label + ' must be an ISO calendar date');
  }
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(timestamp);
  if (
    check.getUTCFullYear() !== Number(match[1]) ||
    check.getUTCMonth() !== Number(match[2]) - 1 ||
    check.getUTCDate() !== Number(match[3])
  ) {
    return fail(label + ' must be an ISO calendar date');
  }
  return value;
}

function assertEffectiveRange(
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  label: string,
): void {
  if (effectiveFrom) assertIsoDate(effectiveFrom, label + ' effective-from date');
  if (effectiveTo) assertIsoDate(effectiveTo, label + ' effective-to date');
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    fail(label + ' effective date range is invalid');
  }
}

function isApproved(status: string): boolean {
  return status.trim().toLowerCase() === 'approved';
}

function isEffectiveOn(
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  date: string,
): boolean {
  return (!effectiveFrom || effectiveFrom <= date) && (!effectiveTo || effectiveTo >= date);
}

function assertCurrentRatePlan(ratePlan: ApprovedRatePlan, pricingDate: string): void {
  requiredText(ratePlan.id, 'Rate plan ID');
  requiredText(ratePlan.code, 'Rate plan code');
  requiredText(ratePlan.name, 'Rate plan name');
  safePositiveInteger(ratePlan.nightlyRateCents, 'Rate-plan nightly rate in cents');
  assertEffectiveRange(ratePlan.effectiveFrom, ratePlan.effectiveTo, 'Rate plan');
  if (!ratePlan.active) fail('Rate plan is inactive');
  if (!isApproved(ratePlan.approvalStatus)) fail('Rate plan is not approved');
  if (!isEffectiveOn(ratePlan.effectiveFrom, ratePlan.effectiveTo, pricingDate)) {
    fail('Rate plan is not effective on the pricing date');
  }
}

function assertCurrentPricingRule(rule: ApprovedPricingRule, pricingDate: string): void {
  requiredText(rule.id, 'Pricing rule ID');
  requiredText(rule.ratePlanId, 'Pricing-rule rate-plan ID');
  requiredText(rule.code, 'Pricing-rule code');
  requiredText(rule.label, 'Pricing-rule label');
  safePositiveInteger(rule.minimumNights, 'Pricing-rule minimum nights');
  if (rule.maximumNights !== null) {
    const maximumNights = safePositiveInteger(rule.maximumNights, 'Pricing-rule maximum nights');
    if (maximumNights < rule.minimumNights) {
      fail('Pricing-rule maximum nights must not be below minimum nights');
    }
  }
  const discountBasisPoints = safeNonNegativeInteger(
    rule.discountBasisPoints,
    'Pricing-rule discount basis points',
  );
  if (discountBasisPoints > FULL_PERCENTAGE_BASIS_POINTS) {
    fail('Pricing-rule discount cannot exceed 100 percent');
  }
  assertEffectiveRange(rule.effectiveFrom, rule.effectiveTo, 'Pricing rule');
  if (!rule.active) fail('Pricing rule is inactive');
  if (!isApproved(rule.approvalStatus)) fail('Pricing rule is not approved');
  if (!isEffectiveOn(rule.effectiveFrom, rule.effectiveTo, pricingDate)) {
    fail('Pricing rule is not effective on the pricing date');
  }
}

function ruleCoversNights(rule: ApprovedPricingRule, nights: number): boolean {
  return nights >= rule.minimumNights && (rule.maximumNights === null || nights <= rule.maximumNights);
}

/**
 * Converts a database decimal amount to exact minor units. Database adapters
 * should call this at their boundary rather than allowing binary floats into
 * quote calculation.
 */
export function decimalToCents(value: DecimalInput, label = 'Amount'): number {
  const raw = typeof value === 'string'
    ? value.trim()
    : Number.isFinite(value)
    ? String(value)
    : '';
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    return fail(label + ' must be a non-negative amount with at most two decimal places');
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) {
    return fail(label + ' exceeds safe integer precision');
  }
  const cents = safeMultiply(whole, 100, label);
  if (cents > Number.MAX_SAFE_INTEGER - fraction) {
    return fail(label + ' exceeds safe integer precision');
  }
  return cents + fraction;
}

/**
 * Converts a decimal percentage such as 15 or 15.25 to integer basis points.
 */
export function percentageToBasisPoints(value: DecimalInput, label = 'Discount percentage'): number {
  const basisPoints = decimalToCents(value, label);
  if (basisPoints > FULL_PERCENTAGE_BASIS_POINTS) {
    return fail(label + ' cannot exceed 100 percent');
  }
  return basisPoints;
}

export function centsToDecimalString(cents: number): string {
  const safeCents = safeNonNegativeInteger(cents, 'Amount in cents');
  const whole = Math.floor(safeCents / 100);
  const fraction = String(safeCents % 100).padStart(2, '0');
  return String(whole) + '.' + fraction;
}

/**
 * Finds exactly one active, approved, effective rule for the selected rate
 * plan. More than one eligible rule is a configuration error, not a discount
 * stacking opportunity.
 */
export function selectEffectivePricingRule(
  input: EffectiveRuleSelectionInput,
): EffectiveRuleSelection {
  const pricingDate = assertIsoDate(input.pricingDate, 'Pricing date');
  const nights = safePositiveInteger(input.nights, 'Nights');
  assertCurrentRatePlan(input.ratePlan, pricingDate);

  const planRules = input.pricingRules.filter((rule) => rule.ratePlanId === input.ratePlan.id);
  const currentRules = planRules.filter((rule) => (
    rule.active &&
    isApproved(rule.approvalStatus) &&
    isEffectiveOn(rule.effectiveFrom, rule.effectiveTo, pricingDate)
  ));

  for (const rule of currentRules) {
    assertCurrentPricingRule(rule, pricingDate);
  }

  const matchingRules = currentRules.filter((rule) => ruleCoversNights(rule, nights));
  if (matchingRules.length === 0) {
    fail('No approved pricing rule covers this stay');
  }
  if (matchingRules.length > 1) {
    fail('Multiple approved pricing rules cover this stay');
  }

  return {
    ratePlan: input.ratePlan,
    pricingRule: matchingRules[0],
    pricingDate,
  };
}

/**
 * Calculates a quote from one selected rule. All monetary values are integer
 * cents; discounts never stack because selection is deliberately singular.
 */
export function calculateQuotePricing(input: EffectiveRuleSelectionInput): QuotePricing {
  const selection = selectEffectivePricingRule(input);
  const grossCents = safeMultiply(
    selection.ratePlan.nightlyRateCents,
    input.nights,
    'Accommodation subtotal',
  );
  const discountNumerator = safeMultiply(
    grossCents,
    selection.pricingRule.discountBasisPoints,
    'Discount amount',
  );
  const discountCents = roundHalfUp(
    discountNumerator,
    FULL_PERCENTAGE_BASIS_POINTS,
    'Discount amount',
  );
  const accommodationTotalCents = grossCents - discountCents;

  return {
    nights: input.nights,
    nightlyRateCents: selection.ratePlan.nightlyRateCents,
    accommodationSubtotalCents: grossCents,
    discountCents,
    accommodationTotalCents,
    discountBasisPoints: selection.pricingRule.discountBasisPoints,
    discountLabel: selection.pricingRule.label,
    ratePlan: {
      id: selection.ratePlan.id,
      code: selection.ratePlan.code,
      name: selection.ratePlan.name,
    },
    pricingRule: {
      id: selection.pricingRule.id,
      code: selection.pricingRule.code,
      label: selection.pricingRule.label,
      minimumNights: selection.pricingRule.minimumNights,
      maximumNights: selection.pricingRule.maximumNights,
      discountBasisPoints: selection.pricingRule.discountBasisPoints,
    },
    lineage: {
      ratePlanId: selection.ratePlan.id,
      ratePlanCode: selection.ratePlan.code,
      pricingRuleId: selection.pricingRule.id,
      pricingRuleCode: selection.pricingRule.code,
      pricingDate: selection.pricingDate,
    },
  };
}

import { createClient } from 'npm:@supabase/supabase-js@2.95.0'
import {
  calculateQuotePricing,
  centsToDecimalString,
  decimalToCents,
  percentageToBasisPoints,
  type ApprovedPricingRule,
  type ApprovedRatePlan,
} from '../_shared/quote-engine.ts'

const url = Deno.env.get('SUPABASE_URL')!
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, secretKey, { auth: { persistSession: false } })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}
const jsonHeaders = { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

interface PublicProperty {
  id: string
  name: string
  public_name: string | null
  operator_name: string | null
  currency: string
}

interface ResolvedPlan {
  plan: ApprovedRatePlan
  currency: string
  automaticDiscountEnabled: boolean
}

interface PublicPresentationSettings {
  checkInTime: string
  checkOutTime: string
  cancellationPolicy: string
  acceptedPaymentMethods: string
  quoteValidityHours: number
  bookingConfirmationText: string
  footerText: string
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'))
}

function requiredText(value: unknown, label: string, maxLength = 160) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${label} is too long`)
  return result
}

function optionalIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!isIsoDate(value)) throw new Error(`${label} is invalid`)
  return value
}

function positiveInteger(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`)
  return number
}

function effectiveOn(from: string | null, to: string | null, date: string) {
  return (!from || from <= date) && (!to || to >= date)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function nightsBetween(checkIn: string, checkOut: string) {
  return Math.round((Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000)
}

function ratePlanCode(value: unknown) {
  const code = requiredText(value, 'Rate-plan code', 64).toLowerCase()
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) throw new Error('Rate-plan code is invalid')
  return code
}

function propertyCurrency(property: PublicProperty) {
  const currency = requiredText(property.currency, 'Property currency', 12).toUpperCase()
  if (currency !== 'USD') throw new Error('Unsupported property currency')
  return currency
}

async function currentProperty() {
  const { data, error } = await db.from('ptm_properties')
    .select('id,name,public_name,operator_name,currency')
    .eq('code', 'LOMBARD').eq('active', true).maybeSingle()
  if (error) throw error
  return data as PublicProperty | null
}

/**
 * The public enquiry renderer has no commercial authority of its own.  It
 * reads only centrally approved presentation text so the no-login PWA can
 * render a customer-safe estimate without recreating policy in the browser.
 */
async function activePublicPresentation(propertyId: string): Promise<PublicPresentationSettings> {
  const { data, error } = await db.from('ptm_quote_presentation_settings')
    .select('check_in_time,check_out_time,cancellation_policy,accepted_payment_methods,quote_validity_hours,booking_confirmation_text,footer_text')
    .eq('property_id', propertyId).eq('active', true).maybeSingle()
  if (error) throw new Error('Quote presentation configuration lookup failed')
  if (!data) throw new Error('No active quote presentation configuration is available')
  const quoteValidityHours = positiveInteger(data.quote_validity_hours, 'Quote validity hours')
  if (!quoteValidityHours) throw new Error('Quote validity hours are required')
  return {
    checkInTime: requiredText(data.check_in_time, 'Presentation check-in time', 120),
    checkOutTime: requiredText(data.check_out_time, 'Presentation check-out time', 120),
    cancellationPolicy: requiredText(data.cancellation_policy, 'Presentation cancellation policy', 500),
    acceptedPaymentMethods: requiredText(data.accepted_payment_methods, 'Presentation payment methods', 500),
    quoteValidityHours,
    bookingConfirmationText: requiredText(data.booking_confirmation_text, 'Presentation booking confirmation', 1000),
    footerText: requiredText(data.footer_text, 'Presentation footer', 500),
  }
}

function toPlan(row: any): ResolvedPlan {
  const effectiveFrom = optionalIsoDate(row.effective_from, 'Rate-plan effective-from date')
  const effectiveTo = optionalIsoDate(row.effective_to, 'Rate-plan effective-to date')
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('Rate-plan effective range is invalid')
  return {
    plan: {
      id: requiredText(row.id, 'Rate-plan ID', 80),
      code: ratePlanCode(row.product_code),
      name: requiredText(row.product_name, 'Rate-plan name'),
      nightlyRateCents: decimalToCents(row.nightly_rate, 'Rate-plan nightly rate'),
      active: row.active === true,
      approvalStatus: requiredText(row.approval_status, 'Rate-plan approval status', 32),
      effectiveFrom,
      effectiveTo,
    },
    currency: requiredText(row.currency, 'Rate-plan currency', 12).toUpperCase(),
    automaticDiscountEnabled: row.automatic_discount_enabled === true,
  }
}

async function publicPlans(property: PublicProperty, pricingDate: string) {
  const { data, error } = await db.from('ptm_rate_plans')
    .select('id,product_code,product_name,nightly_rate,currency,automatic_discount_enabled,effective_from,effective_to,active,approval_status')
    .eq('property_id', property.id).eq('active', true).eq('approval_status', 'approved').eq('public_visible', true)
  if (error) throw error
  return (data || []).map(toPlan).filter((candidate) => effectiveOn(candidate.plan.effectiveFrom, candidate.plan.effectiveTo, pricingDate))
}

async function rulesFor(plan: ApprovedRatePlan) {
  const { data, error } = await db.from('ptm_pricing_rules')
    .select('id,rate_plan_id,rule_code,rule_name,nightly_rate,min_nights,max_nights,discount_percent,effective_from,effective_to,active,approval_status')
    .eq('rate_plan_id', plan.id).eq('active', true).eq('approval_status', 'approved')
  if (error) throw error
  return (data || []).map((row: any): ApprovedPricingRule => {
    const minimumNights = positiveInteger(row.min_nights, 'Pricing-rule minimum nights')!
    const maximumNights = positiveInteger(row.max_nights, 'Pricing-rule maximum nights', true)
    const effectiveFrom = optionalIsoDate(row.effective_from, 'Pricing-rule effective-from date')
    const effectiveTo = optionalIsoDate(row.effective_to, 'Pricing-rule effective-to date')
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('Pricing-rule effective range is invalid')
    if (decimalToCents(row.nightly_rate, 'Pricing-rule nightly rate') !== plan.nightlyRateCents) {
      throw new Error('Pricing-rule nightly rate does not match its rate plan')
    }
    return {
      id: requiredText(row.id, 'Pricing-rule ID', 80),
      ratePlanId: requiredText(row.rate_plan_id, 'Pricing-rule rate-plan ID', 80),
      code: requiredText(row.rule_code, 'Pricing-rule code', 64),
      label: requiredText(row.rule_name, 'Pricing-rule name'),
      minimumNights,
      maximumNights,
      discountBasisPoints: percentageToBasisPoints(row.discount_percent, 'Pricing-rule discount percentage'),
      active: row.active === true,
      approvalStatus: requiredText(row.approval_status, 'Pricing-rule approval status', 32),
      effectiveFrom,
      effectiveTo,
    }
  })
}

async function isAvailable(propertyId: string, checkIn: string, checkOut: string) {
  const { data, error } = await db.from('ptm_bookings').select('id').eq('property_id', propertyId)
    .in('booking_status', ['held', 'confirmed']).lt('check_in', checkOut).gt('check_out', checkIn).limit(1)
  if (error) throw error
  return (data || []).length === 0
}

function publicProperty(property: PublicProperty) {
  return {
    name: requiredText(property.public_name || property.name, 'Property public name'),
    operator_name: typeof property.operator_name === 'string' ? property.operator_name.trim() : '',
    currency: propertyCurrency(property),
  }
}

function publicRenderer(presentation: PublicPresentationSettings) {
  return {
    mode: 'public_enquiry',
    document_title: 'Accommodation Enquiry',
    total_label: 'Estimated Accommodation Total',
    estimate_note: 'Public pricing estimate only. Availability remains subject to reservation confirmation.',
    terms: {
      check_in_time: presentation.checkInTime,
      check_out_time: presentation.checkOutTime,
      cancellation_policy: presentation.cancellationPolicy,
      accepted_payment_methods: presentation.acceptedPaymentMethods,
      quote_validity_hours: presentation.quoteValidityHours,
      booking_confirmation_text: presentation.bookingConfirmationText,
      footer_text: presentation.footerText,
    },
  }
}

function planSummary(rules: ApprovedPricingRule[]) {
  const discounts = rules.filter((rule) => rule.discountBasisPoints > 0)
    .sort((left, right) => left.minimumNights - right.minimumNights)
    .map((rule) => `${rule.minimumNights}+ nights ${rule.discountBasisPoints / 100}%`)
  return discounts.length ? `Automatic stay discounts: ${discounts.join(' / ')}` : 'No automatic length-of-stay discount.'
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method === 'GET') return response({ service: 'PTM Agent Lite public quote preview', status: 'ok', version: '1.1' })
  if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json()
    if (!isRecord(body)) return response({ error: 'Invalid JSON' }, 400)
    const property = await currentProperty()
    if (!property) return response({ error: 'PTM property unavailable' }, 503)
    const pricingDate = todayIso()
    const plans = await publicPlans(property, pricingDate)
    if (!plans.length) return response({ error: 'No approved public rate plans are available' }, 503)
    const renderer = publicRenderer(await activePublicPresentation(property.id))

    if (body.action === 'public_rate_plans') {
      const ratePlans = await Promise.all(plans.map(async (resolvedPlan) => {
        if (resolvedPlan.currency !== propertyCurrency(property)) throw new Error('Rate-plan currency does not match its property')
        const rules = (await rulesFor(resolvedPlan.plan)).filter((rule) => effectiveOn(rule.effectiveFrom, rule.effectiveTo, pricingDate))
        return {
          code: resolvedPlan.plan.code,
          display_name: resolvedPlan.plan.name,
          nightly_rate: centsToDecimalString(resolvedPlan.plan.nightlyRateCents),
          automatic_discount_summary: planSummary(rules),
        }
      }))
      return response({ property: publicProperty(property), rate_plans: ratePlans, renderer })
    }

    if (body.action === 'public_quote_preview') {
      if (!isIsoDate(body.check_in) || !isIsoDate(body.check_out) || body.check_out <= body.check_in) {
        return response({ error: 'Valid check-in and check-out dates are required' }, 400)
      }
      const guestName = requiredText(body.guest_name, 'Guest name')
      const code = ratePlanCode(body.rate_plan_code)
      const matchingPlans = plans.filter((plan) => plan.plan.code === code)
      if (matchingPlans.length !== 1) return response({ error: 'Selected product type is unavailable' }, 400)
      const nights = nightsBetween(body.check_in, body.check_out)
      if (nights < 1) return response({ error: 'Stay must be at least one night' }, 400)
      const resolvedPlan = matchingPlans[0]
      if (resolvedPlan.currency !== propertyCurrency(property)) throw new Error('Rate-plan currency does not match its property')
      const pricing = calculateQuotePricing({
        ratePlan: resolvedPlan.plan,
        pricingRules: await rulesFor(resolvedPlan.plan),
        nights,
        pricingDate,
      })
      if (!resolvedPlan.automaticDiscountEnabled && pricing.discountBasisPoints !== 0) {
        throw new Error('A no-discount rate plan cannot select a discounted pricing rule')
      }
      return response({
        property: publicProperty(property),
        renderer,
        quote: {
          guest_name: guestName,
          check_in: body.check_in,
          check_out: body.check_out,
          nights: pricing.nights,
          rate_plan: { code: pricing.ratePlan.code, display_name: pricing.ratePlan.name },
          nightly_rate: centsToDecimalString(pricing.nightlyRateCents),
          gross_amount: centsToDecimalString(pricing.accommodationSubtotalCents),
          discount_percent: pricing.discountBasisPoints / 100,
          discount_label: pricing.discountLabel,
          discount_amount: centsToDecimalString(pricing.discountCents),
          total_amount: centsToDecimalString(pricing.accommodationTotalCents),
          available: await isAvailable(property.id, body.check_in, body.check_out),
        },
      })
    }

    return response({ error: 'Unknown action' }, 400)
  } catch {
    return response({ error: 'Public quote service unavailable' }, 503)
  }
})

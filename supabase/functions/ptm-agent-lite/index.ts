import { createClient } from 'npm:@supabase/supabase-js@2.95.0'
import {
  calculateQuotePricing,
  centsToDecimalString,
  decimalToCents,
  percentageToBasisPoints,
  type ApprovedPricingRule,
  type ApprovedRatePlan,
  type QuotePricing,
} from '../_shared/quote-engine.ts'
import {
  buildPaymentPlan,
  type ApprovedPaymentRail,
} from '../_shared/payment-control.ts'

const url = Deno.env.get('SUPABASE_URL')!
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const secretKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, secretKey, { auth: { persistSession: false } })

const CAMPAIGN_BUCKET = 'ptm-campaigns'
const CAMPAIGN_ASSET_MAX_BYTES = 10 * 1024 * 1024
const SIGNED_URL_SECONDS = 60 * 60
const CAMPAIGN_STATUSES = ['draft', 'published', 'archived']
const CAMPAIGN_ASSET_TYPES = ['poster', 'social_image', 'flyer', 'whatsapp_artwork', 'other']
const CAMPAIGN_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}
const jsonHeaders = { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

function validDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
}

function validUuid(v: unknown) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
}

function nightsBetween(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasOwn(v: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(v, key)
}

function text(v: unknown, label: string, max: number, required = false) {
  if (typeof v !== 'string') {
    if (required) throw new Error(`${label} is required`)
    return ''
  }
  const value = v.trim()
  if (required && !value) throw new Error(`${label} is required`)
  if (value.length > max) throw new Error(`${label} is too long`)
  return value
}

function optionalText(v: unknown, label: string, max: number) {
  return v === null || v === undefined ? null : text(v, label, max)
}

function optionalDate(v: unknown, label: string) {
  if (v === null || v === '') return null
  if (!validDate(v)) throw new Error(`${label} must be a valid date`)
  return v
}

function safeFileName(v: unknown) {
  const name = text(v, 'File name', 120, true)
  if (/[\\/\u0000]/.test(name)) throw new Error('File name must not include a path')
  const safe = name.replace(/[^a-zA-Z0-9._ -]/g, '_')
  if (!safe || safe === '.' || safe === '..') throw new Error('File name is invalid')
  return safe
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}

async function sha256(s: string) {
  const bytes = new TextEncoder().encode(s)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function authAgent(agentCode: unknown, token: unknown) {
  if (typeof agentCode !== 'string' || typeof token !== 'string' || token.length < 20) return null
  const { data: agent } = await db.from('ptm_agents')
    .select('id,agent_code,display_name,role,active,commission_type,commission_value')
    .eq('agent_code', agentCode.trim().toUpperCase()).eq('active', true).maybeSingle()
  if (!agent) return null
  const hash = await sha256(token)
  const { data: credential } = await db.from('ptm_agent_credentials').select('agent_id')
    .eq('agent_id', agent.id).eq('token_hash', hash).maybeSingle()
  return credential ? agent : null
}

async function getProperty() {
  const { data } = await db.from('ptm_properties').select('id,code,name,public_name,operator_name,location,currency')
    .eq('code', 'LOMBARD').eq('active', true).single()
  return data
}

interface QuotePresentationSettings {
  operatorName: string
  checkInTime: string
  checkOutTime: string
  cancellationPolicy: string
  acceptedPaymentMethods: string
  quoteValidityHours: number
  bookingConfirmationText: string
  footerText: string
}

/**
 * Presentation configuration is deliberately read separately from commercial
 * rules. The quote engine owns the amount; this record owns only the approved
 * customer wording and the lifetime of an issued direct quotation.
 */
async function activeQuotePresentationSettings(propertyId: string): Promise<QuotePresentationSettings> {
  const { data, error } = await db.from('ptm_quote_presentation_settings')
    .select('operator_name,check_in_time,check_out_time,cancellation_policy,accepted_payment_methods,quote_validity_hours,booking_confirmation_text,footer_text')
    .eq('property_id', propertyId).eq('active', true).maybeSingle()
  if (error) throw new Error('Quote presentation configuration lookup failed')
  if (!data) throw new Error('No active quote presentation configuration is available')
  const quoteValidityHours = positiveInteger(data.quote_validity_hours, 'Quote validity hours')
  if (!quoteValidityHours) throw new Error('Quote validity hours are required')
  return {
    operatorName: text(data.operator_name, 'Presentation operator name', 160, true),
    checkInTime: text(data.check_in_time, 'Presentation check-in time', 120, true),
    checkOutTime: text(data.check_out_time, 'Presentation check-out time', 120, true),
    cancellationPolicy: text(data.cancellation_policy, 'Presentation cancellation policy', 500, true),
    acceptedPaymentMethods: text(data.accepted_payment_methods, 'Presentation payment methods', 500, true),
    quoteValidityHours,
    bookingConfirmationText: text(data.booking_confirmation_text, 'Presentation booking confirmation', 1000, true),
    footerText: text(data.footer_text, 'Presentation footer', 500, true),
  }
}

async function blocks(propertyId: string, start: string, end: string) {
  const { data, error } = await db.from('ptm_bookings')
    .select('booking_code,check_in,check_out,booking_status')
    .eq('property_id', propertyId).in('booking_status', ['held', 'confirmed'])
    .lt('check_in', end).gt('check_out', start).order('check_in')
  if (error) throw error
  return data || []
}

/**
 * Commercial data is read from Supabase and converted at this boundary to the
 * exact, integer-cent inputs expected by the shared engines.  Neither browser
 * input nor a legacy rule row is allowed to become an implicit fallback.
 */
interface ResolvedRatePlan {
  plan: ApprovedRatePlan
  automaticDiscountEnabled: boolean
  publicVisible: boolean
  currency: string
}

interface ResolvedPaymentRail {
  rail: ApprovedPaymentRail
  currency: string
  effectiveFrom: string | null
  effectiveTo: string | null
}

function nullableIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!validDate(value)) throw new Error(`${label} must be a valid ISO date`)
  return value
}

function positiveInteger(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`)
  return number
}

function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function isEffectiveOn(effectiveFrom: string | null | undefined, effectiveTo: string | null | undefined, pricingDate: string) {
  return (!effectiveFrom || effectiveFrom <= pricingDate) && (!effectiveTo || effectiveTo >= pricingDate)
}

function ratePlanCode(value: unknown) {
  const code = text(value, 'Rate-plan code', 64, true).toLowerCase()
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) throw new Error('Rate-plan code is invalid')
  return code
}

function currencySymbol(currency: unknown) {
  const code = text(currency, 'Currency', 12, true).toUpperCase()
  if (code === 'USD') return '$'
  throw new Error(`Unsupported payment currency: ${code}`)
}

function toRatePlan(row: any): ResolvedRatePlan {
  const effectiveFrom = nullableIsoDate(row.effective_from, 'Rate-plan effective-from date')
  const effectiveTo = nullableIsoDate(row.effective_to, 'Rate-plan effective-to date')
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('Rate-plan effective range is invalid')
  return {
    plan: {
      id: text(row.id, 'Rate-plan ID', 80, true),
      code: ratePlanCode(row.product_code),
      name: text(row.product_name, 'Rate-plan name', 160, true),
      nightlyRateCents: decimalToCents(row.nightly_rate, 'Rate-plan nightly rate'),
      active: requiredBoolean(row.active, 'Rate-plan active flag'),
      approvalStatus: text(row.approval_status, 'Rate-plan approval status', 32, true),
      effectiveFrom,
      effectiveTo,
    },
    automaticDiscountEnabled: requiredBoolean(row.automatic_discount_enabled, 'Rate-plan automatic-discount flag'),
    publicVisible: requiredBoolean(row.public_visible, 'Rate-plan public-visible flag'),
    currency: text(row.currency, 'Rate-plan currency', 12, true).toUpperCase(),
  }
}

function toPricingRule(row: any, ratePlan: ApprovedRatePlan): ApprovedPricingRule {
  const minimumNights = positiveInteger(row.min_nights, 'Pricing-rule minimum nights')
  const maximumNights = positiveInteger(row.max_nights, 'Pricing-rule maximum nights', true)
  const effectiveFrom = nullableIsoDate(row.effective_from, 'Pricing-rule effective-from date')
  const effectiveTo = nullableIsoDate(row.effective_to, 'Pricing-rule effective-to date')
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('Pricing-rule effective range is invalid')
  const rowNightlyRateCents = decimalToCents(row.nightly_rate, 'Pricing-rule nightly rate')
  if (rowNightlyRateCents !== ratePlan.nightlyRateCents) {
    throw new Error('Pricing-rule nightly rate does not match its rate plan')
  }
  return {
    id: text(row.id, 'Pricing-rule ID', 80, true),
    ratePlanId: text(row.rate_plan_id, 'Pricing-rule rate-plan ID', 80, true),
    code: text(row.rule_code, 'Pricing-rule code', 64, true),
    label: text(row.rule_name, 'Pricing-rule name', 160, true),
    minimumNights: minimumNights!,
    maximumNights,
    discountBasisPoints: percentageToBasisPoints(row.discount_percent, 'Pricing-rule discount percentage'),
    active: requiredBoolean(row.active, 'Pricing-rule active flag'),
    approvalStatus: text(row.approval_status, 'Pricing-rule approval status', 32, true),
    effectiveFrom,
    effectiveTo,
  }
}

function toPaymentRail(row: any): ResolvedPaymentRail {
  const effectiveFrom = nullableIsoDate(row.effective_from, 'Payment-rail effective-from date')
  const effectiveTo = nullableIsoDate(row.effective_to, 'Payment-rail effective-to date')
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('Payment-rail effective range is invalid')
  return {
    rail: {
      id: text(row.id, 'Payment-rail ID', 80, true),
      code: text(row.rail_code, 'Payment-rail code', 64, true).toLowerCase(),
      provider: text(row.provider_name, 'Payment provider name', 120, true),
      agentName: text(row.agent_name, 'Payment agent name', 120, true),
      // Keep this as text: leading zeroes are operationally meaningful.
      agentCode: text(row.agent_code, 'Payment agent code', 80, true),
      ussdPrefix: text(row.ussd_prefix, 'Payment USSD prefix', 80, true),
      maxTransactionCents: decimalToCents(row.max_transaction_amount, 'Payment transaction limit'),
      dailyLimitCents: row.daily_limit_amount === null || row.daily_limit_amount === undefined
        ? null
        : decimalToCents(row.daily_limit_amount, 'Payment daily limit'),
      monthlyLimitCents: row.monthly_limit_amount === null || row.monthly_limit_amount === undefined
        ? null
        : decimalToCents(row.monthly_limit_amount, 'Payment monthly limit'),
      active: requiredBoolean(row.active, 'Payment-rail active flag'),
      approvalStatus: text(row.approval_status, 'Payment-rail approval status', 32, true),
    },
    currency: text(row.currency, 'Payment-rail currency', 12, true).toUpperCase(),
    effectiveFrom,
    effectiveTo,
  }
}

async function activeApprovedRatePlans(propertyId: string, pricingDate: string) {
  const { data, error } = await db.from('ptm_rate_plans')
    .select('id,property_id,product_code,product_name,plan_version,nightly_rate,currency,automatic_discount_enabled,public_visible,effective_from,effective_to,active,approval_status')
    .eq('property_id', propertyId).eq('active', true).eq('approval_status', 'approved')
  if (error) throw new Error('Pricing-plan lookup failed')
  return (data || []).map(toRatePlan).filter((candidate) => (
    isEffectiveOn(candidate.plan.effectiveFrom, candidate.plan.effectiveTo, pricingDate)
  ))
}

async function activeApprovedRatePlan(propertyId: string, productCode: string, pricingDate: string) {
  const candidates = (await activeApprovedRatePlans(propertyId, pricingDate))
    .filter((candidate) => candidate.plan.code === productCode)
  if (!candidates.length) throw new Error('No active approved rate plan is available for this product')
  if (candidates.length > 1) throw new Error('More than one active approved rate plan is available for this product')
  return candidates[0]
}

async function approvedPricingRules(ratePlan: ApprovedRatePlan) {
  const { data, error } = await db.from('ptm_pricing_rules')
    .select('id,rate_plan_id,rule_code,rule_name,nightly_rate,min_nights,max_nights,discount_percent,effective_from,effective_to,active,approval_status')
    .eq('rate_plan_id', ratePlan.id).eq('active', true).eq('approval_status', 'approved')
  if (error) throw new Error('Pricing-rule lookup failed')
  return (data || []).map((row) => toPricingRule(row, ratePlan))
}

async function resolvedQuotePricing(propertyId: string, productCode: string, nights: number, pricingDate: string) {
  const resolvedPlan = await activeApprovedRatePlan(propertyId, productCode, pricingDate)
  const pricingRules = await approvedPricingRules(resolvedPlan.plan)
  const pricing = calculateQuotePricing({
    ratePlan: resolvedPlan.plan,
    pricingRules,
    nights,
    pricingDate,
  })
  if (!resolvedPlan.automaticDiscountEnabled && pricing.discountBasisPoints !== 0) {
    throw new Error('A no-discount rate plan cannot select a discounted pricing rule')
  }
  return { resolvedPlan, pricing }
}

async function activeApprovedPaymentRail(propertyId: string, pricingDate: string) {
  const { data, error } = await db.from('ptm_payment_rails')
    .select('id,property_id,rail_code,rail_version,provider_name,agent_name,agent_code,ussd_prefix,max_transaction_amount,daily_limit_amount,monthly_limit_amount,currency,effective_from,effective_to,active,approval_status')
    .eq('property_id', propertyId).eq('active', true).eq('approval_status', 'approved')
  if (error) throw new Error('Payment-rail lookup failed')
  const rails = (data || []).map(toPaymentRail).filter((candidate) => (
    isEffectiveOn(candidate.effectiveFrom, candidate.effectiveTo, pricingDate)
  ))
  if (!rails.length) throw new Error('No active approved payment rail is available')
  if (rails.length > 1) throw new Error('More than one active approved payment rail is available')
  return rails[0]
}

function publicPricing(pricing: QuotePricing, currency: string) {
  return {
    rate_plan: {
      code: pricing.ratePlan.code,
      name: pricing.ratePlan.name,
    },
    pricing_rule: {
      label: pricing.pricingRule.label,
      minimum_nights: pricing.pricingRule.minimumNights,
      maximum_nights: pricing.pricingRule.maximumNights,
      discount_percent: pricing.discountBasisPoints / 100,
    },
    nights: pricing.nights,
    nightly_rate: centsToDecimalString(pricing.nightlyRateCents),
    accommodation_subtotal: centsToDecimalString(pricing.accommodationSubtotalCents),
    discount_amount: centsToDecimalString(pricing.discountCents),
    accommodation_total: centsToDecimalString(pricing.accommodationTotalCents),
    currency,
  }
}

function publicProperty(property: any) {
  return {
    name: text(property.public_name || property.name, 'Property public name', 160, true),
    operator_name: text(property.operator_name || '', 'Property operator name', 160),
    currency: text(property.currency, 'Property currency', 12, true).toUpperCase(),
  }
}

function quoteExpired(expiresAt: unknown) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw new Error('Quote expiry is invalid')
  return Date.parse(expiresAt) <= Date.now()
}

function publicPaymentPlan(plan: ReturnType<typeof buildPaymentPlan>, currency: string) {
  return {
    quote_code: plan.quoteCode,
    payment_rail: {
      code: plan.paymentRailCode,
      provider_name: plan.provider,
      agent_name: plan.agentName,
      agent_code: plan.agentCode,
      max_transaction_amount: centsToDecimalString(plan.maxTransactionCents),
    },
    payment_amount: centsToDecimalString(plan.totalCents),
    currency,
    mode: plan.mode,
    transaction_count: plan.transactionCount,
    transactions: plan.transactions.map((transaction) => ({
      sequence: transaction.sequence,
      amount: centsToDecimalString(transaction.amountCents),
      ussd: transaction.ussd,
    })),
    is_balanced: plan.isBalanced,
    is_ready: plan.isReady,
    reason: plan.reason,
    copy_action: plan.clipboardKind === 'ussd' ? 'Copy USSD'
      : plan.clipboardKind === 'payment_instructions' ? 'Copy payment instructions'
      : null,
    clipboard_kind: plan.clipboardKind,
    clipboard_text: plan.clipboardText,
  }
}

async function publicRatePlans(property: any, pricingDate: string) {
  const propertyCurrency = text(property.currency, 'Property currency', 12, true).toUpperCase()
  const plans = (await activeApprovedRatePlans(property.id, pricingDate))
    .filter((resolvedPlan) => resolvedPlan.publicVisible)
  if (!plans.length) throw new Error('No approved public rate plans are available')
  return Promise.all(plans.map(async (resolvedPlan) => {
    if (resolvedPlan.currency !== propertyCurrency) throw new Error('Rate-plan currency does not match its property')
    const rules = await approvedPricingRules(resolvedPlan.plan)
    const effectiveRules = rules
      .filter((rule) => isEffectiveOn(rule.effectiveFrom, rule.effectiveTo, pricingDate))
      .sort((left, right) => left.minimumNights - right.minimumNights)
    const discountSummary = effectiveRules
      .filter((rule) => rule.discountBasisPoints > 0)
      .map((rule) => `${rule.minimumNights}+ nights ${rule.discountBasisPoints / 100}%`)
      .join(' · ')
    return {
      code: resolvedPlan.plan.code,
      display_name: resolvedPlan.plan.name,
      nightly_rate: centsToDecimalString(resolvedPlan.plan.nightlyRateCents),
      automatic_discount_summary: discountSummary
        ? `Automatic stay discounts: ${discountSummary}`
        : 'No automatic length-of-stay discount.',
    }
  }))
}

function makeCode(prefix: string) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()
  return `${prefix}-${stamp}-${suffix}`
}

const CAMPAIGN_SELECT = `
  id,campaign_code,property_id,pricing_rule_id,title,description,approved_copy,terms,
  valid_from,valid_to,always_visible,status,published_at,created_by,created_at,updated_at,
  property:ptm_properties!ptm_campaigns_property_id_fkey(id,code,name,location,currency)
`

function campaignIsVisible(campaign: any, today = todayIso()) {
  return campaign.always_visible || (campaign.valid_from <= today && (!campaign.valid_to || campaign.valid_to >= today))
}

async function campaignAssets(campaignIds: string[], includePending = false) {
  const byCampaign = new Map<string, any[]>()
  if (!campaignIds.length) return byCampaign
  let query = db.from('ptm_campaign_assets')
    .select('id,campaign_id,file_name,storage_path,asset_type,mime_type,file_size_bytes,upload_status,uploaded_at,created_at')
    .in('campaign_id', campaignIds).order('created_at')
  if (!includePending) query = query.eq('upload_status', 'ready')
  const { data, error } = await query
  if (error) throw error
  for (const asset of data || []) {
    const assets = byCampaign.get(asset.campaign_id) || []
    assets.push(asset)
    byCampaign.set(asset.campaign_id, assets)
  }
  return byCampaign
}

async function assetLinks(asset: any) {
  if (asset.upload_status !== 'ready') return { view_url: null, download_url: null }
  const [{ data: view, error: viewError }, { data: download, error: downloadError }] = await Promise.all([
    db.storage.from(CAMPAIGN_BUCKET).createSignedUrl(asset.storage_path, SIGNED_URL_SECONDS),
    db.storage.from(CAMPAIGN_BUCKET).createSignedUrl(asset.storage_path, SIGNED_URL_SECONDS, { download: true }),
  ])
  if (viewError || downloadError) throw viewError || downloadError
  return { view_url: view?.signedUrl || null, download_url: download?.signedUrl || null }
}

async function campaignResponse(campaign: any, assets: any[], admin = false) {
  const assetResponse = await Promise.all(assets.map(async (asset) => ({
    id: asset.id,
    file_name: asset.file_name,
    asset_type: asset.asset_type,
    mime_type: asset.mime_type,
    file_size_bytes: asset.file_size_bytes,
    created_at: asset.created_at,
    ...(admin ? { upload_status: asset.upload_status, uploaded_at: asset.uploaded_at } : {}),
    ...(await assetLinks(asset)),
  })))
  return {
    id: campaign.id,
    campaign_code: campaign.campaign_code,
    property: campaign.property,
    title: campaign.title,
    description: campaign.description,
    approved_copy: campaign.approved_copy,
    terms: campaign.terms,
    valid_from: campaign.valid_from,
    valid_to: campaign.valid_to,
    always_visible: campaign.always_visible,
    status: campaign.status,
    published_at: campaign.published_at,
    created_at: campaign.created_at,
    assets: assetResponse,
    ...(admin ? { property_id: campaign.property_id, pricing_rule_id: campaign.pricing_rule_id, created_by: campaign.created_by, updated_at: campaign.updated_at } : {}),
  }
}

async function getCampaign(campaignId: string) {
  const { data, error } = await db.from('ptm_campaigns').select(CAMPAIGN_SELECT).eq('id', campaignId).maybeSingle()
  if (error) throw error
  return data
}

async function listCampaigns(kind: 'active' | 'past' | 'admin') {
  const { data, error } = await db.from('ptm_campaigns').select(CAMPAIGN_SELECT)
    .order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
  if (error) throw error
  const today = todayIso()
  const campaigns = (data || []).filter((campaign) => {
    if (kind === 'admin') return true
    if (campaign.status !== 'published') return false
    if (kind === 'active') return campaignIsVisible(campaign, today)
    return !campaign.always_visible && Boolean(campaign.valid_to) && campaign.valid_to < today
  })
  const assetsByCampaign = await campaignAssets(campaigns.map((campaign) => campaign.id), kind === 'admin')
  return Promise.all(campaigns.map((campaign) => campaignResponse(campaign, assetsByCampaign.get(campaign.id) || [], kind === 'admin')))
}

async function campaignAssetLink(assetId: string) {
  const { data: asset, error } = await db.from('ptm_campaign_assets')
    .select('id,campaign_id,file_name,storage_path,asset_type,mime_type,file_size_bytes,upload_status,uploaded_at,created_at')
    .eq('id', assetId).eq('upload_status', 'ready').maybeSingle()
  if (error) throw error
  if (!asset) return null
  const campaign = await getCampaign(asset.campaign_id)
  if (!campaign || campaign.status !== 'published' || !campaignIsVisible(campaign)) return null
  return { asset: { id: asset.id, file_name: asset.file_name, asset_type: asset.asset_type, mime_type: asset.mime_type }, ...(await assetLinks(asset)) }
}

async function approvedPricingRule(propertyId: string, ruleId: string | null) {
  if (!ruleId) return true
  const { data, error } = await db.from('ptm_pricing_rules').select('id')
    .eq('id', ruleId).eq('property_id', propertyId).eq('active', true).eq('approval_status', 'approved').maybeSingle()
  if (error) throw error
  return Boolean(data)
}

function campaignInput(body: Record<string, unknown>, current?: any) {
  const propertyId = hasOwn(body, 'property_id') ? body.property_id : current?.property_id
  if (!validUuid(propertyId)) throw new Error('A valid property is required')
  const title = hasOwn(body, 'title') ? text(body.title, 'Title', 160, true) : current?.title
  if (!title) throw new Error('Title is required')
  const description = hasOwn(body, 'description') ? optionalText(body.description, 'Description', 2000) : current?.description
  const approvedCopy = hasOwn(body, 'approved_copy') ? text(body.approved_copy, 'Approved copy', 10000) : current?.approved_copy || ''
  const terms = hasOwn(body, 'terms') ? optionalText(body.terms, 'Terms', 3000) : current?.terms
  const validFrom = hasOwn(body, 'valid_from') ? optionalDate(body.valid_from, 'Valid-from date') : current?.valid_from
  if (!validFrom) throw new Error('Valid-from date is required')
  const validTo = hasOwn(body, 'valid_to') ? optionalDate(body.valid_to, 'Valid-until date') : current?.valid_to
  if (validTo && validTo < validFrom) throw new Error('Valid-until date cannot be before valid-from date')
  const alwaysVisible = hasOwn(body, 'always_visible') ? body.always_visible : current?.always_visible
  if (typeof alwaysVisible !== 'boolean') throw new Error('Continuous visibility must be true or false')
  const status = hasOwn(body, 'status') ? body.status : current?.status || 'draft'
  if (typeof status !== 'string' || !CAMPAIGN_STATUSES.includes(status)) throw new Error('Campaign status is invalid')
  const pricingRuleId = hasOwn(body, 'pricing_rule_id') ? body.pricing_rule_id : current?.pricing_rule_id
  if (pricingRuleId !== null && pricingRuleId !== undefined && !validUuid(pricingRuleId)) throw new Error('Pricing-rule reference is invalid')
  return { property_id: propertyId, title, description, approved_copy: approvedCopy, terms, valid_from: validFrom, valid_to: validTo, always_visible: alwaysVisible, status, pricing_rule_id: pricingRuleId || null }
}

async function createCampaign(body: Record<string, unknown>, agent: any) {
  const input = campaignInput(body)
  if (!await approvedPricingRule(input.property_id, input.pricing_rule_id)) throw new Error('Campaign pricing must reference an active approved rule for the same property')
  const { data, error } = await db.from('ptm_campaigns').insert({ ...input, created_by: agent.id, published_at: input.status === 'published' ? new Date().toISOString() : null })
    .select(CAMPAIGN_SELECT).single()
  if (error) throw error
  return campaignResponse(data, [], true)
}

async function updateCampaign(body: Record<string, unknown>) {
  if (!validUuid(body.campaign_id)) throw new Error('Campaign ID is required')
  const current = await getCampaign(body.campaign_id)
  if (!current) throw new Error('Campaign not found')
  const input = campaignInput(body, current)
  if (!await approvedPricingRule(input.property_id, input.pricing_rule_id)) throw new Error('Campaign pricing must reference an active approved rule for the same property')
  const { data, error } = await db.from('ptm_campaigns').update({ ...input, published_at: input.status === 'published' ? current.published_at || new Date().toISOString() : current.published_at })
    .eq('id', current.id).select(CAMPAIGN_SELECT).single()
  if (error) throw error
  const assetsByCampaign = await campaignAssets([data.id], true)
  return campaignResponse(data, assetsByCampaign.get(data.id) || [], true)
}

async function createCampaignAssetUpload(body: Record<string, unknown>, agent: any) {
  if (!validUuid(body.campaign_id)) throw new Error('Campaign ID is required')
  const campaign = await getCampaign(body.campaign_id)
  if (!campaign) throw new Error('Campaign not found')
  const fileName = safeFileName(body.file_name)
  if (typeof body.mime_type !== 'string' || !CAMPAIGN_MIME_TYPES.includes(body.mime_type)) throw new Error('Unsupported asset type')
  if (typeof body.asset_type !== 'string' || !CAMPAIGN_ASSET_TYPES.includes(body.asset_type)) throw new Error('Asset classification is invalid')
  if (!Number.isInteger(body.file_size_bytes) || Number(body.file_size_bytes) < 1 || Number(body.file_size_bytes) > CAMPAIGN_ASSET_MAX_BYTES) throw new Error('Asset must be between 1 byte and 10 MB')
  const storagePath = `${campaign.id}/${crypto.randomUUID()}-${fileName}`
  const { data: asset, error: insertError } = await db.from('ptm_campaign_assets').insert({
    campaign_id: campaign.id, file_name: fileName, storage_path: storagePath, asset_type: body.asset_type,
    mime_type: body.mime_type, file_size_bytes: body.file_size_bytes, created_by: agent.id,
  }).select('id,campaign_id,file_name,storage_path,asset_type,mime_type,file_size_bytes,upload_status,uploaded_at,created_at').single()
  if (insertError) throw insertError
  const { data: signedUpload, error: signingError } = await db.storage.from(CAMPAIGN_BUCKET).createSignedUploadUrl(storagePath)
  if (signingError || !signedUpload) {
    await db.from('ptm_campaign_assets').delete().eq('id', asset.id)
    throw signingError || new Error('Could not create an upload URL')
  }
  return { asset: { id: asset.id, file_name: asset.file_name, asset_type: asset.asset_type, mime_type: asset.mime_type, upload_status: asset.upload_status }, storage_path: storagePath, signed_upload: signedUpload }
}

async function finalizeCampaignAsset(body: Record<string, unknown>) {
  if (!validUuid(body.asset_id)) throw new Error('Asset ID is required')
  const { data: asset, error } = await db.from('ptm_campaign_assets').select('id,storage_path').eq('id', body.asset_id).maybeSingle()
  if (error) throw error
  if (!asset) throw new Error('Campaign asset not found')
  const parts = asset.storage_path.split('/')
  const objectName = parts.pop() || ''
  const { data: objects, error: listError } = await db.storage.from(CAMPAIGN_BUCKET).list(parts.join('/'), { limit: 20, search: objectName })
  if (listError) throw listError
  if (!(objects || []).some((object) => object.name === objectName)) throw new Error('Upload has not completed yet')
  const { data: ready, error: updateError } = await db.from('ptm_campaign_assets')
    .update({ upload_status: 'ready', uploaded_at: new Date().toISOString() }).eq('id', asset.id)
    .select('id,campaign_id,file_name,storage_path,asset_type,mime_type,file_size_bytes,upload_status,uploaded_at,created_at').single()
  if (updateError) throw updateError
  return { asset: { id: ready.id, file_name: ready.file_name, asset_type: ready.asset_type, mime_type: ready.mime_type, upload_status: ready.upload_status, ...(await assetLinks(ready)) } }
}

async function deleteCampaignAsset(body: Record<string, unknown>) {
  if (!validUuid(body.asset_id)) throw new Error('Asset ID is required')
  const { data: asset, error } = await db.from('ptm_campaign_assets').select('id,storage_path').eq('id', body.asset_id).maybeSingle()
  if (error) throw error
  if (!asset) throw new Error('Campaign asset not found')
  const { error: removeError } = await db.storage.from(CAMPAIGN_BUCKET).remove([asset.storage_path])
  if (removeError) throw removeError
  const { error: deleteError } = await db.from('ptm_campaign_assets').delete().eq('id', asset.id)
  if (deleteError) throw deleteError
  return { deleted: true }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method === 'GET') return j({ service: 'PTM Agent Lite API', status: 'ok', version: '2.0' })
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!isObject(parsed)) return j({ error: 'Invalid JSON' }, 400)
    body = parsed
  } catch {
    return j({ error: 'Invalid JSON' }, 400)
  }

  try {
    const action = body.action
    if (typeof action !== 'string') return j({ error: 'Action is required' }, 400)

    const agent = await authAgent(body.agent_code, body.token)
    if (!agent) return j({ error: 'Invalid agent code or token' }, 401)

    if (action === 'login') {
      const property = await getProperty()
      if (!property) return j({ error: 'PTM property unavailable' }, 503)
      return j({ agent: { agent_code: agent.agent_code, display_name: agent.display_name, role: agent.role }, property })
    }
    if (action === 'campaigns') return j({ campaigns: await listCampaigns('active') })
    if (action === 'past_campaigns') return j({ campaigns: await listCampaigns('past') })
    if (action === 'campaign_asset_link') {
      if (!validUuid(body.asset_id)) return j({ error: 'Asset ID is required' }, 400)
      const asset = await campaignAssetLink(body.asset_id)
      return asset ? j(asset) : j({ error: 'Campaign asset is unavailable' }, 404)
    }

    const property = await getProperty()
    if (!property) return j({ error: 'PTM property unavailable' }, 503)

    if (action === 'calendar') {
      if (!validDate(body.start) || !validDate(body.end) || body.end <= body.start) return j({ error: 'Valid calendar dates are required' }, 400)
      return j({ blocks: await blocks(property.id, body.start, body.end) })
    }
    if (action === 'availability') {
      if (!validDate(body.check_in) || !validDate(body.check_out) || body.check_out <= body.check_in) return j({ error: 'Valid check-in and check-out dates are required' }, 400)
      const nights = nightsBetween(body.check_in, body.check_out)
      const found = await blocks(property.id, body.check_in, body.check_out)
      return j({ available: found.length === 0, nights, blocks: found })
    }
    if (action === 'quote') {
      const guest = text(body.guest_name, 'Guest name', 160, true)
      if (!validDate(body.check_in) || !validDate(body.check_out) || body.check_out <= body.check_in) return j({ error: 'Valid check-in and check-out dates are required' }, 400)
      const checkIn = body.check_in as string
      const checkOut = body.check_out as string
      const nights = nightsBetween(checkIn, checkOut)
      if (nights < 1) return j({ error: 'Stay must be at least one night' }, 400)
      if ((await blocks(property.id, checkIn, checkOut)).length) return j({ error: 'Those dates overlap a held or confirmed booking' }, 409)
      const pricingDate = todayIso()
      const { resolvedPlan, pricing } = await resolvedQuotePricing(
        property.id,
        ratePlanCode(body.rate_plan_code),
        nights,
        pricingDate,
      )
      const propertyCurrency = text(property.currency, 'Property currency', 12, true).toUpperCase()
      if (resolvedPlan.currency !== propertyCurrency) throw new Error('Rate-plan currency does not match its property')
      const presentation = await activeQuotePresentationSettings(property.id)
      const expiresAt = new Date(Date.now() + presentation.quoteValidityHours * 60 * 60 * 1000).toISOString()
      const { data: quote, error } = await db.from('ptm_quotes').insert({
        quote_code: makeCode('PTM-Q'), property_id: property.id, agent_id: agent.id, guest_name: guest,
        check_in: checkIn, check_out: checkOut, nights,
        nightly_rate: centsToDecimalString(pricing.nightlyRateCents),
        discount_percent: pricing.discountBasisPoints / 100,
        subtotal_amount: centsToDecimalString(pricing.accommodationSubtotalCents),
        discount_amount: centsToDecimalString(pricing.discountCents),
        total_amount: centsToDecimalString(pricing.accommodationTotalCents),
        currency: resolvedPlan.currency,
        rate_plan_id: pricing.lineage.ratePlanId,
        pricing_rule_id: pricing.lineage.pricingRuleId,
        rate_plan_code: pricing.lineage.ratePlanCode,
        pricing_rule_code: pricing.lineage.pricingRuleCode,
        pricing_date: pricing.lineage.pricingDate,
        pricing_lineage_status: 'resolved',
        status: 'issued',
        expires_at: expiresAt,
      }).select('quote_code,guest_name,check_in,check_out,nights,nightly_rate,discount_percent,subtotal_amount,discount_amount,total_amount,currency,rate_plan_code,pricing_rule_code,pricing_date,status,expires_at').single()
      if (error) return j({ error: 'Could not create quote' }, 500)
      return j({
        quote: {
          ...quote,
          rate_plan: { code: pricing.ratePlan.code, name: pricing.ratePlan.name },
          pricing_rule: {
            code: pricing.pricingRule.code,
            label: pricing.pricingRule.label,
            discount_percent: pricing.discountBasisPoints / 100,
          },
        },
        agent: { agent_code: agent.agent_code, display_name: agent.display_name },
        presentation: {
          property_name: text(property.public_name || property.name, 'Property public name', 160, true),
          operator_name: presentation.operatorName,
          check_in_time: presentation.checkInTime,
          check_out_time: presentation.checkOutTime,
          cancellation_policy: presentation.cancellationPolicy,
          accepted_payment_methods: presentation.acceptedPaymentMethods,
          quote_validity_hours: presentation.quoteValidityHours,
          booking_confirmation_text: presentation.bookingConfirmationText,
          footer_text: presentation.footerText,
        },
      })
    }
    if (action === 'payment_plan') {
      const quoteCode = text(body.quote_code, 'Quote reference', 96, true)
      const { data: quote, error } = await db.from('ptm_quotes')
        .select('id,quote_code,property_id,agent_id,total_amount,currency,status,expires_at,pricing_lineage_status')
        .eq('quote_code', quoteCode).eq('agent_id', agent.id).in('status', ['issued', 'accepted']).maybeSingle()
      if (error) throw error
      if (!quote || quote.property_id !== property.id) return j({ error: 'Quote not found or cannot be used for payment' }, 404)
      if (quote.pricing_lineage_status !== 'resolved') {
        return j({ error: 'Quote does not have resolved approved pricing lineage' }, 409)
      }
      if (quoteExpired(quote.expires_at)) return j({ error: 'Quote has expired and cannot be used for payment' }, 409)
      const quoteCurrency = text(quote.currency, 'Quote currency', 12, true).toUpperCase()
      const propertyCurrency = text(property.currency, 'Property currency', 12, true).toUpperCase()
      if (quoteCurrency !== propertyCurrency) return j({ error: 'Quote currency does not match this property' }, 409)
      const resolvedRail = await activeApprovedPaymentRail(property.id, todayIso())
      if (resolvedRail.currency !== quoteCurrency) return j({ error: 'Payment rail currency does not match the quote' }, 409)
      const plan = buildPaymentPlan({
        quote: {
          quoteCode: quote.quote_code,
          amountRequiredCents: decimalToCents(quote.total_amount, 'Quote amount required'),
          currency: quoteCurrency,
          currencySymbol: currencySymbol(quoteCurrency),
        },
        rail: resolvedRail.rail,
      })
      if (!plan.isReady || !plan.isBalanced) return j({ error: plan.reason || 'Payment plan is unavailable' }, 409)
      return j({ payment_plan: publicPaymentPlan(plan, quoteCurrency) })
    }
    if (action === 'submit_booking') {
      const quoteCode = typeof body.quote_code === 'string' ? body.quote_code.trim() : ''
      if (!quoteCode) return j({ error: 'Quote reference is required' }, 400)
      const { data: quote } = await db.from('ptm_quotes').select('*').eq('quote_code', quoteCode).eq('agent_id', agent.id).in('status', ['issued', 'accepted']).maybeSingle()
      if (!quote) return j({ error: 'Quote not found or cannot be booked' }, 404)
      if (quote.pricing_lineage_status !== 'resolved') {
        return j({ error: 'Quote does not have resolved approved pricing lineage' }, 409)
      }
      if (quoteExpired(quote.expires_at)) return j({ error: 'Quote has expired and cannot be booked' }, 409)
      if ((await blocks(property.id, quote.check_in, quote.check_out)).length) return j({ error: 'Dates are no longer available' }, 409)
      const { data: booking, error } = await db.from('ptm_bookings').insert({
        booking_code: makeCode('PTM-B'), property_id: property.id, quote_id: quote.id, agent_id: agent.id,
        check_in: quote.check_in, check_out: quote.check_out, booking_status: 'held', payment_status: 'unpaid',
        booking_value: quote.total_amount, commission_status: agent.commission_type === 'pending' ? 'pending_rule' : 'pending_booking', source: 'agent_lite',
      }).select('booking_code,check_in,check_out,booking_status,payment_status,booking_value,commission_status').single()
      if (error) {
        if ((error as any).code === '23P01') return j({ error: 'Dates were just taken by another booking. Please refresh availability.' }, 409)
        return j({ error: 'Could not create booking request' }, 500)
      }
      await db.from('ptm_quotes').update({ status: 'converted' }).eq('id', quote.id)
      return j({ booking })
    }
    if (action.startsWith('admin_')) {
      if (agent.role !== 'admin') return j({ error: 'PTM admin access is required' }, 403)
      if (action === 'admin_campaigns') return j({ campaigns: await listCampaigns('admin') })
      if (action === 'admin_properties') {
        const { data, error } = await db.from('ptm_properties').select('id,code,name,location,currency,active').order('name')
        if (error) throw error
        return j({ properties: data || [] })
      }
      if (action === 'admin_create_campaign') return j({ campaign: await createCampaign(body, agent) }, 201)
      if (action === 'admin_update_campaign') return j({ campaign: await updateCampaign(body) })
      if (action === 'admin_create_asset_upload') return j(await createCampaignAssetUpload(body, agent), 201)
      if (action === 'admin_finalize_asset') return j(await finalizeCampaignAsset(body))
      if (action === 'admin_delete_asset') return j(await deleteCampaignAsset(body))
      return j({ error: 'Unknown admin action' }, 400)
    }
    return j({ error: 'Unknown action' }, 400)
  } catch (error) {
    return j({ error: errorMessage(error) }, 400)
  }
})

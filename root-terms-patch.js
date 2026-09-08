/* PTM Quote Engine — approved direct-booking terms presentation patch.
 * Keeps the existing pricing/payment engine untouched while aligning
 * screen, WhatsApp, email and print/PDF quotation wording.
 */

renderDirectBookingTerms = function renderDirectBookingTermsPatched() {
  let termsSection = $('previewTerms');
  if (!termsSection) {
    termsSection = document.createElement('section');
    termsSection.id = 'previewTerms';
    termsSection.className = 'quote-terms';

    const title = document.createElement('h3');
    title.className = 'text-xs font-bold uppercase tracking-[0.16em] text-slate-500';
    title.textContent = 'Terms & Conditions';

    const list = document.createElement('dl');
    list.id = 'previewTermsList';
    list.className = 'quote-terms-list';
    termsSection.append(title, list);

    $('previewValidity').insertAdjacentElement('afterend', termsSection);
  }

  const list = $('previewTermsList');
  list.replaceChildren();
  const items = [
    ['Check-in', CONFIG.directBookingTerms.checkInTime],
    ['Check-out', CONFIG.directBookingTerms.checkOutTime],
    ['Booking confirmation', CONFIG.directBookingTerms.bookingConfirmationText],
    ['Cancellation', CONFIG.directBookingTerms.cancellationPolicy],
    ['Quotation validity', `${CONFIG.quoteValidityHours} hours.`],
    ['Payment options', CONFIG.directBookingTerms.acceptedPaymentMethods]
  ];

  items.forEach(([label, value]) => {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  });

  $('previewValidity').hidden = true;

  let footer = $('previewTermsFooter');
  if (!footer) {
    footer = document.createElement('p');
    footer.id = 'previewTermsFooter';
    footer.className = 'mt-4 text-xs italic leading-5 text-slate-500';
    termsSection.insertAdjacentElement('afterend', footer);
  }
  footer.textContent = CONFIG.directBookingTerms.footerText;
};

buildWhatsAppMessage = function buildWhatsAppMessagePatched(quote) {
  const lines = [
    `*${CONFIG.propertyName.toUpperCase()}*`,
    `_by ${CONFIG.operatorName}_`,
    '*ACCOMMODATION QUOTATION*',
    `Quote Ref: ${quote.reference}`,
    '',
    `*Guest:* ${quote.guest}`,
    `*Check-in:* ${formatDate(quote.checkIn)}`,
    `*Check-out:* ${formatDate(quote.checkOut)}`,
    `*Duration:* ${formatNights(quote.nights)}`,
    `*Product Type:* ${quote.productType}`,
    '',
    '--------------------------------',
    '',
    `Nightly Rate: ${formatCurrency(quote.rate)}`,
    `Accommodation Subtotal: ${formatCurrency(quote.gross)}`
  ];

  if (quote.discountAmount > 0) {
    lines.push(`${quote.discountLabel}${quote.discountPercentage > 0 ? ` (${quote.discountPercentage}%)` : ''}: -${formatCurrency(quote.discountAmount)}`);
  }
  if (quote.cleaningEnabled && quote.cleaningFee > 0) {
    lines.push(`Cleaning Fee: ${formatCurrency(quote.cleaningFee)}`);
  }

  lines.push('', `*Accommodation Total: ${formatCurrency(quote.accommodationTotal)}*`);
  if (quote.depositEnabled && quote.securityDeposit > 0) {
    lines.push(`Refundable Security Deposit: ${formatCurrency(quote.securityDeposit)}`);
  }

  lines.push(
    '',
    '--------------------------------',
    '',
    `*AMOUNT REQUIRED: ${formatCurrency(quote.amountRequired)}*`,
    '',
    '*TERMS & CONDITIONS*',
    `Check-in: ${CONFIG.directBookingTerms.checkInTime}`,
    `Check-out: ${CONFIG.directBookingTerms.checkOutTime}`,
    `Booking confirmation: ${CONFIG.directBookingTerms.bookingConfirmationText}`,
    `Cancellation: ${CONFIG.directBookingTerms.cancellationPolicy}`,
    `Quotation validity: ${CONFIG.quoteValidityHours} hours.`,
    `Payment options: ${CONFIG.directBookingTerms.acceptedPaymentMethods}`,
    '',
    CONFIG.directBookingTerms.footerText
  );

  return lines.join('\n');
};

buildEmailMessage = function buildEmailMessagePatched(quote) {
  const lines = [
    CONFIG.propertyName.toUpperCase(),
    `by ${CONFIG.operatorName}`,
    'ACCOMMODATION QUOTATION',
    '',
    `Quote Reference: ${quote.reference}`,
    `Guest: ${quote.guest}`,
    `Check-in: ${formatDate(quote.checkIn)}`,
    `Check-out: ${formatDate(quote.checkOut)}`,
    `Duration: ${formatNights(quote.nights)}`,
    `Product Type: ${quote.productType}`,
    '',
    'PRICING',
    `Nightly Rate: ${formatCurrency(quote.rate)}`,
    `Accommodation Subtotal: ${formatCurrency(quote.gross)}`
  ];

  if (quote.discountAmount > 0) {
    lines.push(`${quote.discountLabel}${quote.discountPercentage > 0 ? ` (${quote.discountPercentage}%)` : ''}: -${formatCurrency(quote.discountAmount)}`);
  }
  if (quote.cleaningEnabled && quote.cleaningFee > 0) {
    lines.push(`Cleaning Fee: ${formatCurrency(quote.cleaningFee)}`);
  }

  lines.push(`Accommodation Total: ${formatCurrency(quote.accommodationTotal)}`);
  if (quote.depositEnabled && quote.securityDeposit > 0) {
    lines.push(`Refundable Security Deposit: ${formatCurrency(quote.securityDeposit)}`);
  }

  lines.push(
    '',
    `AMOUNT REQUIRED: ${formatCurrency(quote.amountRequired)}`,
    '',
    'TERMS & CONDITIONS',
    `Check-in: ${CONFIG.directBookingTerms.checkInTime}`,
    `Check-out: ${CONFIG.directBookingTerms.checkOutTime}`,
    `Booking confirmation: ${CONFIG.directBookingTerms.bookingConfirmationText}`,
    `Cancellation: ${CONFIG.directBookingTerms.cancellationPolicy}`,
    `Quotation validity: ${CONFIG.quoteValidityHours} hours.`,
    `Payment options: ${CONFIG.directBookingTerms.acceptedPaymentMethods}`,
    '',
    CONFIG.directBookingTerms.footerText
  );

  return lines.join('\n');
};

renderDirectBookingTerms();
if (lastQuote) updateQuote();

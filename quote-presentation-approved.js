/* PTM Quote Engine — approved customer presentation additions.
 * Adds Quote Date plus the approved Contact & Location block across
 * screen/print, WhatsApp and email without altering pricing or payment logic.
 */

CONFIG.customerContact = {
  address: 'Lombard Mansions, 63 Sixth Street, Avenues, Harare, Zimbabwe',
  zimbabwe: '+263 719 216 306',
  unitedKingdom: '+44 7721 030509'
};

function approvedQuoteIssueDate(quote) {
  const reference = String(quote?.reference || '');
  const match = reference.match(/^PTM-(\d{4})(\d{2})(\d{2})-/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    }).format(date);
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  }).format(new Date());
}

function renderApprovedQuoteIdentity(quote) {
  const referenceElement = $('previewReference');
  if (referenceElement) {
    let dateElement = $('previewQuoteDate');
    if (!dateElement) {
      dateElement = document.createElement('p');
      dateElement.id = 'previewQuoteDate';
      dateElement.className = 'mt-1 text-xs font-medium text-slate-500';
      referenceElement.insertAdjacentElement('afterend', dateElement);
    }
    dateElement.textContent = `Quote Date: ${approvedQuoteIssueDate(quote)}`;
  }

  const termsSection = $('previewTerms');
  if (!termsSection) return;

  let contactSection = $('previewContact');
  if (!contactSection) {
    contactSection = document.createElement('section');
    contactSection.id = 'previewContact';
    contactSection.className = 'quote-terms';
    contactSection.innerHTML = `
      <h3 class="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Contact &amp; Location</h3>
      <div class="mt-3 space-y-2 text-xs leading-5 text-slate-600">
        <p><strong class="text-slate-700">Address:</strong> <span id="previewContactAddress"></span></p>
        <p><strong class="text-slate-700">Zimbabwe:</strong> <span id="previewContactZimbabwe"></span> — Call or WhatsApp</p>
        <p><strong class="text-slate-700">United Kingdom:</strong> <span id="previewContactUK"></span> — Call or WhatsApp</p>
      </div>`;

    const footer = $('previewTermsFooter');
    if (footer) footer.insertAdjacentElement('beforebegin', contactSection);
    else termsSection.insertAdjacentElement('afterend', contactSection);
  }

  $('previewContactAddress').textContent = CONFIG.customerContact.address;
  $('previewContactZimbabwe').textContent = CONFIG.customerContact.zimbabwe;
  $('previewContactUK').textContent = CONFIG.customerContact.unitedKingdom;
}

const ptmOriginalRenderQuote = renderQuote;
renderQuote = function renderQuoteWithApprovedIdentity(quote, validation) {
  ptmOriginalRenderQuote(quote, validation);
  renderApprovedQuoteIdentity(quote);
};

const ptmOriginalBuildWhatsAppMessage = buildWhatsAppMessage;
buildWhatsAppMessage = function buildWhatsAppMessageWithApprovedIdentity(quote) {
  let output = ptmOriginalBuildWhatsAppMessage(quote);
  const issueDate = approvedQuoteIssueDate(quote);

  output = output.replace(
    `Quote Ref: ${quote.reference}`,
    `Quote Ref: ${quote.reference}\nQuote Date: ${issueDate}`
  );

  const contactBlock = [
    '*CONTACT & LOCATION*',
    `Address: ${CONFIG.customerContact.address}`,
    '',
    `Zimbabwe: ${CONFIG.customerContact.zimbabwe} — Call or WhatsApp`,
    '',
    `United Kingdom: ${CONFIG.customerContact.unitedKingdom} — Call or WhatsApp`,
    '',
    CONFIG.directBookingTerms.footerText
  ].join('\n');

  output = output.replace(CONFIG.directBookingTerms.footerText, contactBlock);
  return output;
};

const ptmOriginalBuildEmailMessage = buildEmailMessage;
buildEmailMessage = function buildEmailMessageWithApprovedIdentity(quote) {
  let output = ptmOriginalBuildEmailMessage(quote);
  const issueDate = approvedQuoteIssueDate(quote);

  output = output.replace(
    `Quote Reference: ${quote.reference}`,
    `Quote Reference: ${quote.reference}\nQuote Date: ${issueDate}`
  );

  const contactBlock = [
    'CONTACT & LOCATION',
    `Address: ${CONFIG.customerContact.address}`,
    '',
    `Zimbabwe: ${CONFIG.customerContact.zimbabwe} — Call or WhatsApp`,
    '',
    `United Kingdom: ${CONFIG.customerContact.unitedKingdom} — Call or WhatsApp`,
    '',
    CONFIG.directBookingTerms.footerText
  ].join('\n');

  output = output.replace(CONFIG.directBookingTerms.footerText, contactBlock);
  return output;
};

if (lastQuote) updateQuote();

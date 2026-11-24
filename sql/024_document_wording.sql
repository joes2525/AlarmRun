-- Editable wording for documents (certificates, quotes, invoices, T&Cs), stored as templates with channel 'doc'
insert into templates (company_id, kind, channel, name, subject, body)
select c.id, v.kind, 'doc', v.name, null, v.body from companies c, (values
 ('cert_compliant', 'Certificate – compliant statement',
  'The smoke alarms at {Address}, {Suburb} were inspected, tested and cleaned on {Visit date} and, at the time of inspection, met the requirements of Queensland smoke alarm legislation.'),
 ('cert_non_compliant', 'Certificate – non-compliant statement',
  'The smoke alarms at {Address}, {Suburb} were inspected on {Visit date} and, at the time of inspection, did not meet the requirements of Queensland smoke alarm legislation. See the work recommended above.'),
 ('quote_terms', 'Quote – terms',
  'This quote is valid for 30 days. Prices include GST. Work will be booked once the quote is accepted by the property manager or owner.'),
 ('invoice_notes', 'Invoice – notes',
  'Payment is due within 14 days. Please use the invoice number as your payment reference.'),
 ('terms_conditions', 'Terms and conditions',
  '[Your terms and conditions go here]')
) v(kind, name, body)
on conflict do nothing;

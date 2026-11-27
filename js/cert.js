// Compliance certificate for one job: cert.html?job=<job id>. The same layout will be used for the emailed PDF.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const d = v => v ? new Date(v).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' }) : '—';
const ym = v => v ? new Date(v + 'T00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : '—';

const fillDoc = (t, v) => Object.entries(v).reduce((s, [k, x]) => s.split('{' + k + '}').join(x ?? ''), t || '');

async function load() {
  const id = new URLSearchParams(location.search).get('job');
  if (!id) return $('#msg').textContent = 'No job given';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return $('#msg').textContent = 'Please log in to the office app first';
  const { data: j, error } = await sb.from('jobs').select(`id, company_id, completed_at, scheduled_start, outcome, outcome_notes, approved_at,
      blind_cleats, blind_cleats_needed, safety_switch, safety_switch_notes, comment_photo,
      properties(address_line, suburb, postcode, photo, owner_name, storeys, bedrooms, clients(name, type, billing_email)),
      inspectors(name), certificates(number, compliant, issued_at),
      alarm_checks(action, replace_reason, quote, photo_path, action_price, alarms(location, sensor_type, power_source, brand, manufacture_date, expiry_date))`).eq('id', id).single();
  if (error) return $('#msg').textContent = error.message;
  const [{ data: co }, { data: words }] = await Promise.all([
    sb.from('companies').select('name, sender_name, phone, reply_to_email, abn, qbcc_licence, electrical_licence, bank_account_name, bank_bsb, bank_account_number, payment_terms_days').eq('id', j.company_id).single(),
    sb.from('templates').select('kind, body').eq('channel', 'doc').in('kind', ['cert_compliant', 'cert_non_compliant'])]);
  const p = j.properties || {}, cert = [].concat(j.certificates || [])[0] || {}, ok = cert.compliant;
  const today = new Date().toISOString().slice(0, 10);
  const checks = (j.alarm_checks || []).sort((a, b) => (a.alarms?.location || '').localeCompare(b.alarms?.location || ''));
  // photos are private: get short-lived links to show them
  const pics = checks.filter(c => c.photo_path).map(c => ({ path: c.photo_path, label: `${c.alarms?.location || ''} – ${c.action || ''}` }));
  if (j.comment_photo) pics.push({ path: j.comment_photo, label: 'Inspector comment' });
  const store = [...pics.map(x => x.path), ...(p.photo && !p.photo.startsWith('img/') ? [p.photo] : [])];
  let propPic = p.photo?.startsWith('img/') ? p.photo : '';
  if (store.length) {
    const { data: urls } = await sb.storage.from('photos').createSignedUrls(store, 3600);
    (urls || []).forEach((u, i) => i < pics.length ? pics[i].url = u.signedUrl : propPic = u.signedUrl);
  }
  $('#previewNote').textContent = j.approved_at ? 'Approved' : 'Preview – not yet approved';
  document.title = `Certificate ${cert.number || ''} – ${p.address_line || ''}`;
  $('#cert').innerHTML = `
    <header>
      <div><h1>Smoke Alarm Compliance Certificate</h1><div>Certificate no. <b>${esc(cert.number || '—')}</b></div></div>
      <div class="co"><b>${esc(co?.sender_name || co?.name)}</b><br>${co?.phone ? esc(co.phone) + '<br>' : ''}${co?.reply_to_email ? esc(co.reply_to_email) + '<br>' : ''}
        ${co?.abn ? 'ABN ' + esc(co.abn) + '<br>' : ''}${co?.electrical_licence ? 'Electrical licence ' + esc(co.electrical_licence) + '<br>' : ''}${co?.qbcc_licence ? 'QBCC ' + esc(co.qbcc_licence) : ''}</div>
    </header>
    <div class="result ${ok ? 'ok' : 'no'}">${ok ? '✓ THIS PROPERTY IS COMPLIANT' : '✗ THIS PROPERTY IS NOT COMPLIANT'}</div>
    <div class="prop"><div class="grid">
      <div><span>Property</span>${esc(p.address_line)}, ${esc(p.suburb)} QLD ${esc(p.postcode)}</div>
      <div><span>Owner</span>${esc(p.owner_name || (p.clients?.type && p.clients.type !== 'agency' ? p.clients.name : p.clients?.name ? 'c/- ' + p.clients.name : '—'))}</div>
      <div><span>Inspection date</span>${d(j.completed_at || j.scheduled_start)}</div>
      <div><span>Inspector</span>${esc(j.inspectors?.name || '—')}</div>
      <div><span>Levels / bedrooms</span>${esc(p.storeys || '—')} / ${esc(p.bedrooms ?? '—')}</div>
      <div><span>Next service due</span>${d(new Date(new Date(j.completed_at || j.scheduled_start).setFullYear(new Date(j.completed_at || j.scheduled_start).getFullYear() + 1)))}</div>
    </div>${propPic ? `<img src="${esc(propPic)}" alt="Property">` : '<div></div>'}</div>
    <h2>Smoke alarms</h2>
    <table><tr><th>Location</th><th>Type</th><th>Power</th><th>Manufactured</th><th>Expires</th><th>Work done</th></tr>
      ${checks.map(c => { const a = c.alarms || {}, exp = a.expiry_date && a.expiry_date < today;
        return `<tr><td>${esc(a.location)}</td><td>${esc(a.sensor_type)}</td><td>${esc((a.power_source || '').replace('10yr_lithium', '10-yr lithium').replace('hardwired', '240V hardwired'))}</td>
          <td>${ym(a.manufacture_date)}</td><td class="${exp ? 'bad' : ''}">${ym(a.expiry_date)}</td>
          <td>${esc(c.action || '—')}${c.action === 'Replaced' && c.replace_reason ? ` (${esc(c.replace_reason)})` : ''}${c.quote ? `<br><small>Recommended: ${esc(c.quote)}</small>` : ''}</td></tr>`; }).join('')
        || '<tr><td colspan="6">No alarms recorded</td></tr>'}
    </table>
    <h2>Other checks</h2>
    <div class="grid">
      <div><span>Blind cord safety cleats</span>${esc(j.blind_cleats || '—')}${['Needed', 'Installed'].includes(j.blind_cleats) && j.blind_cleats_needed ? ` (${j.blind_cleats_needed})` : ''}</div>
      <div><span>Safety switch</span>${esc(j.safety_switch || '—')}${j.safety_switch_notes ? ` – ${esc(j.safety_switch_notes)}` : ''}</div>
    </div>
    ${j.outcome_notes ? `<h2>Inspector comments</h2><p>${esc(j.outcome_notes)}</p>` : ''}
    <p class="stmt">${esc(fillDoc((words || []).find(w => w.kind === (ok ? 'cert_compliant' : 'cert_non_compliant'))?.body
      || (ok ? 'The smoke alarms at this property were inspected, tested and cleaned on the date above and, at the time of inspection, met the requirements of Queensland smoke alarm legislation.'
             : 'The smoke alarms at this property were inspected on the date above and, at the time of inspection, did not meet the requirements of Queensland smoke alarm legislation. See the work recommended above.'),
      { Address: p.address_line, Suburb: p.suburb, Postcode: p.postcode || '', 'Visit date': d(j.completed_at || j.scheduled_start), Company: co?.sender_name || co?.name || '',
        Inspector: j.inspectors?.name || '' })).replace(/\n/g, '<br>')}</p>
    <footer>Issued by ${esc(co?.sender_name || co?.name)} · Certificate ${esc(cert.number || '')} · ${d(cert.issued_at)}${pics.some(x => x.url) ? ' · Page 1 of 2' : ''}</footer>`;
  // tax invoice in front when extra (priced) work was done
  const lines = checks.filter(c => Number(c.action_price) > 0).map(c => ({
    desc: `${c.action === 'Replaced' && c.replace_reason ? `Replaced smoke alarm (${c.replace_reason})` : c.action} – ${c.alarms?.location || ''}`, amt: Number(c.action_price) }));
  $('#inv').hidden = !lines.length;
  if (lines.length) {
    const total = lines.reduce((t, l) => t + l.amt, 0), gst = total / 11, m = v => '$' + v.toFixed(2);
    const issued = j.approved_at || new Date().toISOString(), terms = co?.payment_terms_days ?? 14, due = new Date(new Date(issued).getTime() + terms * 864e5);
    const cl = p.clients || {}, owner = p.owner_name || (cl.type && cl.type !== 'agency' ? cl.name : '');
    $('#inv').innerHTML = `<div class="inv">
      <header>
        <div><h1>TAX INVOICE</h1><div>Invoice no. <b>INV-${esc(String(cert.number || '').split('-').pop())}</b></div>
          <div>Date issued: ${d(issued)}</div><div>Due: ${d(due)}</div></div>
        <div class="co"><b>${esc(co?.sender_name || co?.name)}</b><br>${co?.abn ? 'ABN ' + esc(co.abn) + '<br>' : '<span class="bad">ABN missing – add in Settings</span><br>'}
          ${co?.phone ? esc(co.phone) + '<br>' : ''}${co?.reply_to_email ? esc(co.reply_to_email) : ''}</div>
      </header>
      <div class="billto"><b>Bill to</b><br>${esc(owner || (cl.name ? 'c/- ' + cl.name : '—'))}${owner && cl.type === 'agency' ? `<br>c/- ${esc(cl.name)}` : ''}${cl.billing_email ? '<br>' + esc(cl.billing_email) : ''}
        <br><b>Property</b>: ${esc(p.address_line)}, ${esc(p.suburb)} QLD ${esc(p.postcode)} · Inspected ${d(j.completed_at || j.scheduled_start)} · Certificate ${esc(cert.number || '')}</div>
      <table><tr><th>Description</th><th class="n">Qty</th><th class="n">GST</th><th class="n">Amount (inc GST)</th></tr>
        ${lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="n">1</td><td class="n">${m(l.amt / 11)}</td><td class="n">${m(l.amt)}</td></tr>`).join('')}</table>
      <table class="tot"><tr><td>Subtotal (ex GST)</td><td class="n">${m(total - gst)}</td></tr><tr><td>GST</td><td class="n">${m(gst)}</td></tr>
        <tr><td>Total (inc GST)</td><td class="n">${m(total)}</td></tr></table>
      <p><small>Total price includes GST.</small></p>
      <div class="pay"><b>Payment</b> – please pay within ${terms} days, quoting INV-${esc(String(cert.number || '').split('-').pop())} as the reference.<br>
        ${co?.bank_account_number ? `Account name: <b>${esc(co.bank_account_name || co.name)}</b> · BSB: <b>${esc(co.bank_bsb || '')}</b> · Account: <b>${esc(co.bank_account_number)}</b>`
          : '<span class="bad">Bank details missing – add them in Settings</span>'}</div>
      <footer>${esc(co?.sender_name || co?.name)}${co?.abn ? ' · ABN ' + esc(co.abn) : ''} · Tax invoice</footer></div>`;
  }
  // inspection photos on a second page
  const shown = pics.filter(x => x.url);
  $('#cert2').hidden = !shown.length;
  if (shown.length) $('#cert2').innerHTML = `
    <header><div><h1>Inspection photos</h1><div>${esc(p.address_line)}, ${esc(p.suburb)} QLD ${esc(p.postcode)}</div></div>
      <div class="co">Certificate no. <b>${esc(cert.number || '—')}</b><br>${d(j.completed_at || j.scheduled_start)}</div></header>
    <div class="pics big" style="margin-top:14px">${shown.map(x =>
      `<figure><img src="${esc(x.url)}" alt="${esc(x.label)}"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>
    <footer>Issued by ${esc(co?.sender_name || co?.name)} · Certificate ${esc(cert.number || '')} · Page 2 of 2</footer>`;
}
load();

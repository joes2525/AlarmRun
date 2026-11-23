// Compliance certificate for one job: cert.html?job=<job id>. The same layout will be used for the emailed PDF.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const d = v => v ? new Date(v).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' }) : '—';
const ym = v => v ? new Date(v + 'T00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : '—';

async function load() {
  const id = new URLSearchParams(location.search).get('job');
  if (!id) return $('#msg').textContent = 'No job given';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return $('#msg').textContent = 'Please log in to the office app first';
  const { data: j, error } = await sb.from('jobs').select(`id, company_id, completed_at, scheduled_start, outcome, outcome_notes, approved_at,
      blind_cleats, blind_cleats_needed, safety_switch, safety_switch_notes, comment_photo,
      properties(address_line, suburb, postcode, storeys, bedrooms, clients(name)),
      inspectors(name), certificates(number, compliant, issued_at),
      alarm_checks(action, replace_reason, quote, photo_path, alarms(location, sensor_type, power_source, brand, manufacture_date, expiry_date))`).eq('id', id).single();
  if (error) return $('#msg').textContent = error.message;
  const { data: co } = await sb.from('companies').select('name, sender_name, phone, reply_to_email, abn, qbcc_licence').eq('id', j.company_id).single();
  const p = j.properties || {}, cert = [].concat(j.certificates || [])[0] || {}, ok = cert.compliant;
  const today = new Date().toISOString().slice(0, 10);
  const checks = (j.alarm_checks || []).sort((a, b) => (a.alarms?.location || '').localeCompare(b.alarms?.location || ''));
  // photos are private: get short-lived links to show them
  const pics = checks.filter(c => c.photo_path).map(c => ({ path: c.photo_path, label: `${c.alarms?.location || ''} – ${c.action || ''}` }));
  if (j.comment_photo) pics.push({ path: j.comment_photo, label: 'Inspector comment' });
  if (pics.length) {
    const { data: urls } = await sb.storage.from('photos').createSignedUrls(pics.map(x => x.path), 3600);
    (urls || []).forEach((u, i) => pics[i].url = u.signedUrl);
  }
  $('#previewNote').textContent = j.approved_at ? 'Approved' : 'Preview – not yet approved';
  document.title = `Certificate ${cert.number || ''} – ${p.address_line || ''}`;
  $('#cert').innerHTML = `
    <header>
      <div><h1>Smoke Alarm Compliance Certificate</h1><div>Certificate no. <b>${esc(cert.number || '—')}</b></div></div>
      <div class="co"><b>${esc(co?.sender_name || co?.name)}</b><br>${co?.phone ? esc(co.phone) + '<br>' : ''}${co?.reply_to_email ? esc(co.reply_to_email) + '<br>' : ''}
        ${co?.abn ? 'ABN ' + esc(co.abn) + '<br>' : ''}${co?.qbcc_licence ? 'QBCC ' + esc(co.qbcc_licence) : ''}</div>
    </header>
    <div class="result ${ok ? 'ok' : 'no'}">${ok ? '✓ THIS PROPERTY IS COMPLIANT' : '✗ THIS PROPERTY IS NOT COMPLIANT'}</div>
    <div class="grid">
      <div><span>Property</span>${esc(p.address_line)}, ${esc(p.suburb)} QLD ${esc(p.postcode)}</div>
      <div><span>Agent</span>${esc(p.clients?.name || '—')}</div>
      <div><span>Inspection date</span>${d(j.completed_at || j.scheduled_start)}</div>
      <div><span>Inspector</span>${esc(j.inspectors?.name || '—')}</div>
      <div><span>Levels / bedrooms</span>${esc(p.storeys || '—')} / ${esc(p.bedrooms ?? '—')}</div>
      <div><span>Next service due</span>${d(new Date(new Date(j.completed_at || j.scheduled_start).setFullYear(new Date(j.completed_at || j.scheduled_start).getFullYear() + 1)))}</div>
    </div>
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
    <p class="stmt">${ok
      ? 'The smoke alarms at this property were inspected, tested and cleaned on the date above and, at the time of inspection, met the requirements of Queensland smoke alarm legislation.'
      : 'The smoke alarms at this property were inspected on the date above and, at the time of inspection, did <b>not</b> meet the requirements of Queensland smoke alarm legislation. See the work recommended above.'}</p>
    ${pics.some(x => x.url) ? `<h2>Photos</h2><div class="pics">${pics.filter(x => x.url).map(x =>
      `<figure><img src="${esc(x.url)}" alt="${esc(x.label)}"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>` : ''}
    <footer>Issued by ${esc(co?.sender_name || co?.name)} · Certificate ${esc(cert.number || '')} · ${d(cert.issued_at)}</footer>`;
}
load();

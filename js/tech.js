// AlarmRun inspector app: today's run → inspect alarms → complete & issue certificate.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = t => { $('#msg').textContent = t || ''; if (t) scrollTo(0, 0); };
const show = id => ['login', 'run', 'job'].forEach(s => $('#' + s).hidden = s !== id);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const niceDate = d => new Date(d + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let companyId = null, inspectorId = null, day = iso(new Date()), job = null;

// ---------- start-up ----------
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('login');
  const { data: m, error } = await sb.from('memberships').select('company_id,role').limit(1);
  if (error || !m?.length) return msg(error?.message || 'Your login is not linked to a company yet');
  companyId = m[0].company_id;
  const { data: ins } = await sb.from('inspectors').select('id,name,user_id').eq('active', true).order('name');
  const mine = (ins || []).find(i => i.user_id === session.user.id);
  if (mine) inspectorId = mine.id;
  else if (['owner', 'admin'].includes(m[0].role)) {     // office staff can view any inspector's run
    const pick = $('#asInspector');
    pick.innerHTML = ins.map(i => `<option value="${i.id}">Viewing as: ${esc(i.name)}</option>`).join('');
    pick.value = ins.some(i => i.id === store.get('asInspector')) ? store.get('asInspector') : ins[0]?.id;
    pick.hidden = false; inspectorId = pick.value;
    pick.onchange = () => { inspectorId = pick.value; store.set('asInspector', inspectorId); loadRun(); };
  } else return msg('Your login is not linked to an inspector yet – ask the office');
  loadRun();
}

// ---------- today's run ----------
async function loadRun() {
  show('run'); msg('');
  $('#dayLabel').textContent = day === iso(new Date()) ? 'Today' : niceDate(day);
  const { data, error } = await sb.from('jobs')
    .select('id,job_type,status,route_order,notes,property_id,properties(address_line,suburb,postcode,access_notes,clients(name))')
    .eq('inspector_id', inspectorId).gte('scheduled_start', day + 'T00:00').lte('scheduled_start', day + 'T23:59')
    .in('status', ['booked', 'in_progress', 'completed', 'no_access']).order('route_order', { nullsFirst: false });
  if (error) return msg(error.message);
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease', install: 'Install' };
  const left = data.filter(j => ['booked', 'in_progress'].includes(j.status)).length;
  $('#jobs').innerHTML = `<p class="muted">${data.length} jobs · ${left} to do</p>` + (data.map((j, i) => {
    const p = j.properties || {}, done = !['booked', 'in_progress'].includes(j.status);
    return `<div class="card ${done ? 'done' : ''}" data-job="${j.id}">
      <h3><span class="num">${i + 1}</span>${esc(p.address_line)}</h3>
      <div class="muted">${esc(p.suburb)} ${esc(p.postcode)} · ${esc(p.clients?.name)}
        <span class="tag">${label[j.job_type] || esc(j.job_type)}</span>${done ? `<span class="tag">${j.status === 'completed' ? '✓ done' : 'no access'}</span>` : ''}</div>
      ${j.notes ? `<div style="margin-top:6px">${esc(j.notes)}</div>` : ''}
      ${p.access_notes ? `<div class="muted" style="margin-top:4px">${esc(p.access_notes)}</div>` : ''}
    </div>`;
  }).join('') || '<div class="card">No jobs booked for this day.</div>');
}
$('#jobs').onclick = e => { const c = e.target.closest('[data-job]'); if (c) openJob(c.dataset.job); };
const shiftDay = n => { const d = new Date(day + 'T00:00'); d.setDate(d.getDate() + n); day = iso(d); loadRun(); };
$('#prevDay').onclick = () => shiftDay(-1);
$('#nextDay').onclick = () => shiftDay(1);
$('#back').onclick = () => loadRun();

// ---------- one job ----------
async function openJob(id) {
  show('job'); msg(''); $('#jobBody').innerHTML = '<p class="muted">Loading…</p>';
  const { data: j, error } = await sb.from('jobs')
    .select('id,job_type,status,locked,notes,property_id,properties(address_line,suburb,postcode,access_notes,storeys,clients(name))').eq('id', id).single();
  if (error) return msg(error.message);
  const [{ data: alarms }, { data: ten }] = await Promise.all([
    sb.from('alarms').select('id,location,storey,sensor_type,power_source,brand,expiry_date,interconnected').eq('property_id', j.property_id).eq('active', true).order('location'),
    sb.from('tenancies').select('tenant_names,mobile,email').eq('property_id', j.property_id).order('lease_start', { ascending: false, nullsFirst: false }).limit(1)]);
  job = { ...j, alarms: alarms || [], newAlarms: [], checks: {}, tenant: ten?.[0] || {} };
  job.alarms.forEach(a => job.checks[a.id] = { alarm_id: a.id, tested_ok: false, cleaned: false, battery_replaced: false, replaced: false, interconnected: a.interconnected ?? true });
  renderJob();
}

function renderJob() {
  const p = job.properties || {}, t = job.tenant, today = iso(new Date()), done = job.locked || job.status !== 'booked';
  const addr = encodeURIComponent(`${p.address_line}, ${p.suburb} QLD ${p.postcode || ''}`);
  $('#jobBody').innerHTML = `
    <div class="card">
      <h3>${esc(p.address_line)}</h3><div class="muted">${esc(p.suburb)} ${esc(p.postcode)} · ${esc(p.clients?.name)}</div>
      ${job.notes ? `<p>${esc(job.notes)}</p>` : ''}${p.access_notes ? `<p class="muted">${esc(p.access_notes)}</p>` : ''}
      <p><b>${esc(t.tenant_names || 'No tenant on file')}</b></p>
      <div class="row">
        ${t.mobile ? `<a href="tel:${esc(t.mobile.replace(/\s/g, ''))}"><button style="width:100%">📞 Call</button></a>` : ''}
        <a href="https://www.google.com/maps/dir/?api=1&destination=${addr}" target="_blank"><button style="width:100%">🧭 Navigate</button></a>
      </div>
    </div>
    ${done ? `<div class="card">This job is ${esc(job.status.replace('_', ' '))}${job.locked ? ' and locked' : ''}.</div>` : `
    <h3>Alarms (${job.alarms.length + job.newAlarms.length})</h3>
    ${job.alarms.map(a => alarmCard(a, today)).join('')}
    ${job.newAlarms.map((a, i) => `<div class="card"><h3>➕ ${esc(a.location)}</h3><div class="muted">New ${esc(a.sensor_type)} · ${esc(a.power_source)} · made ${esc(a.manufacture_date || '?')}</div>
      <button class="link" data-remove-new="${i}">Remove</button></div>`).join('')}
    <details class="card"><summary><b>➕ Add an alarm</b> (e.g. missing bedroom)</summary>
      <input id="naLoc" placeholder="Location e.g. Bedroom 3">
      <select id="naType"><option>photoelectric</option><option>heat</option></select>
      <select id="naPower"><option value="10yr_lithium">10-year lithium</option><option value="hardwired">Hardwired 240V</option></select>
      <label class="muted">Manufacture date</label><input id="naDate" type="month" value="${today.slice(0, 7)}">
      <button id="naAdd">Add alarm</button>
    </details>
    <div class="card"><h3>Compliance checklist</h3>
      ${[['bedrooms', 'An alarm in every bedroom'], ['hallways', 'An alarm in hallways connecting bedrooms'], ['storeys', 'An alarm on every storey'],
         ['photo', 'All alarms are photoelectric'], ['inter', 'All alarms are interconnected'], ['age', 'No alarm is older than 10 years'], ['tested', 'All alarms tested and working']]
        .map(([k, l]) => `<label class="check"><input type="checkbox" data-cl="${k}"> ${l}</label>`).join('')}
      <textarea id="jobNotes" rows="3" placeholder="Notes for the office / agent"></textarea>
    </div>
    <button class="primary" id="complete">Complete inspection & issue certificate</button>
    <div class="row"><button class="danger" id="noAccess">No access</button></div>`}`;
}

function alarmCard(a, today) {
  const c = job.checks[a.id], expired = a.expiry_date && a.expiry_date < today;
  const tg = (k, l) => `<label><input type="checkbox" data-alarm="${a.id}" data-k="${k}"${c[k] ? ' checked' : ''}> ${l}</label>`;
  return `<div class="card">
    <h3>${esc(a.location)}${a.storey > 1 ? ` <span class="tag">storey ${a.storey}</span>` : ''}</h3>
    <div class="muted">${esc(a.sensor_type)} · ${esc(a.power_source)} · ${esc(a.brand || '')}
      <span class="${expired ? 'bad' : ''}">expires ${esc(a.expiry_date || '?')}${expired ? ' – EXPIRED' : ''}</span></div>
    <div class="toggles">${tg('tested_ok', 'Tested OK')}${tg('cleaned', 'Cleaned')}${tg('battery_replaced', 'Battery replaced')}${tg('replaced', 'Replaced')}${tg('interconnected', 'Interconnected')}
      <label class="photo">📷 ${c.photo_path ? 'Retake' : 'Photo'}<input type="file" accept="image/*" capture="environment" data-photo="${a.id}"></label></div>
    ${c.photo_path ? '<div class="photo-ok">Photo saved ✓</div>' : ''}
    ${c.replaced ? `<div class="replace">New alarm:
      <select data-alarm="${a.id}" data-k="new_sensor_type"><option>photoelectric</option><option>heat</option></select>
      <select data-alarm="${a.id}" data-k="new_power_source"><option value="10yr_lithium">10-year lithium</option><option value="hardwired">Hardwired 240V</option></select>
      <label class="muted">Manufacture date</label><input type="month" data-alarm="${a.id}" data-k="new_manufacture_date" value="${(c.new_manufacture_date || today).slice(0, 7)}"></div>` : ''}
  </div>`;
}

// tick boxes / fields on alarm cards
$('#jobBody').addEventListener('change', async e => {
  const t = e.target, id = t.dataset.alarm;
  if (id && t.dataset.k) {
    const c = job.checks[id];
    c[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.type === 'month' ? t.value + '-01' : t.value;
    if (t.dataset.k === 'replaced') { if (t.checked) { c.new_sensor_type ??= 'photoelectric'; c.new_power_source ??= '10yr_lithium'; c.new_manufacture_date ??= iso(new Date()).slice(0, 7) + '-01'; c.tested_ok = true; } renderJob(); }
  }
  if (t.dataset.photo && t.files[0]) {
    msg('Uploading photo…');
    const path = `${companyId}/${job.id}/${t.dataset.photo}-${Date.now()}.jpg`;
    const { error } = await sb.storage.from('photos').upload(path, t.files[0], { contentType: t.files[0].type || 'image/jpeg' });
    if (error) return msg('Photo upload failed: ' + error.message);
    job.checks[t.dataset.photo].photo_path = path; msg(''); renderJob();
  }
});

$('#jobBody').addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.removeNew) { job.newAlarms.splice(+t.dataset.removeNew, 1); return renderJob(); }
  if (t.id === 'naAdd') {
    const loc = $('#naLoc').value.trim(); if (!loc) return msg('Enter where the new alarm is');
    job.newAlarms.push({ location: loc, sensor_type: $('#naType').value, power_source: $('#naPower').value, manufacture_date: $('#naDate').value + '-01', interconnected: true });
    return renderJob();
  }
  if (t.id === 'noAccess') {
    const why = prompt('Why was there no access? (e.g. no one home, keys didn\'t work)'); if (!why) return;
    const { error } = await sb.from('jobs').update({ status: 'no_access', outcome_notes: why }).eq('id', job.id);
    if (error) return msg(error.message);
    msg('Marked as no access – the office will rebook'); return loadRun();
  }
  if (t.id === 'complete') {
    const untested = job.alarms.filter(a => !job.checks[a.id].tested_ok && !job.checks[a.id].replaced);
    if (untested.length && !confirm(`${untested.length} alarm(s) not marked tested OK or replaced. Complete anyway?`)) return;
    const boxes = [...document.querySelectorAll('[data-cl]')], compliant = boxes.every(b => b.checked);
    if (!compliant && !confirm('Not every checklist item is ticked, so the certificate will say NOT COMPLIANT. Continue?')) return;
    t.disabled = true; t.textContent = 'Saving…';
    const { data: cert, error } = await sb.rpc('complete_job', { p_job: job.id, p_checks: Object.values(job.checks),
      p_new_alarms: job.newAlarms, p_compliant: compliant, p_notes: $('#jobNotes').value || null });
    if (error) { t.disabled = false; t.textContent = 'Complete inspection & issue certificate'; return msg(error.message); }
    msg(''); alert(`Done ✓ Certificate ${cert} (${compliant ? 'compliant' : 'NOT compliant'})`);
    loadRun();
  }
});

// ---------- login ----------
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) return msg(error.message);
  msg(''); start();
};
$('#logout').onclick = async () => { await sb.auth.signOut(); show('login'); };

start();

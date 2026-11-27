// AlarmRun inspector app: today's run → inspect alarms → complete & issue certificate.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = t => { $('#msg').textContent = t || ''; if (t) scrollTo(0, 0); };
const show = id => ['login', 'home', 'run', 'job'].forEach(s => $('#' + s).hidden = s !== id);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const niceDate = d => new Date(d + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let inspectorName = '', areaOf = {};
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
  if (mine) { inspectorId = mine.id; inspectorName = mine.name; }
  else if (['owner', 'admin'].includes(m[0].role)) {     // office staff can view any inspector's run
    const pick = $('#asInspector');
    pick.innerHTML = ins.map(i => `<option value="${i.id}">Viewing as: ${esc(i.name)}</option>`).join('');
    pick.value = ins.some(i => i.id === store.get('asInspector')) ? store.get('asInspector') : ins[0]?.id;
    pick.hidden = false; inspectorId = pick.value; inspectorName = ins.find(i => i.id === inspectorId)?.name || '';
    pick.onchange = () => { inspectorId = pick.value; inspectorName = ins.find(i => i.id === inspectorId)?.name || ''; store.set('asInspector', inspectorId); loadHome(); };
  } else return msg('Your login is not linked to an inspector yet – ask the office');
  const { data: areas } = await sb.from('suburb_areas').select('suburb,area');
  (areas || []).forEach(a => areaOf[a.suburb] = a.area);
  loadHome();
}

// ---------- home ----------
async function loadHome() {
  show('home'); msg('');
  const t = iso(new Date()), end = new Date(); end.setDate(end.getDate() + 21);
  const h = new Date().getHours();
  $('#hello').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${inspectorName ? ', ' + inspectorName : ''}`;
  $('#today').textContent = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const { data, error } = await sb.from('jobs').select('id,status,scheduled_start,route_order,properties(address_line,suburb,postcode)')
    .eq('inspector_id', inspectorId).gte('scheduled_start', t + 'T00:00').lte('scheduled_start', iso(end) + 'T23:59')
    .in('status', ['booked', 'in_progress', 'completed', 'no_access']).order('scheduled_start').order('route_order', { nullsFirst: false });
  if (error) return msg(error.message);
  const todays = data.filter(j => j.scheduled_start.slice(0, 10) === t);
  const done = todays.filter(j => ['completed', 'no_access'].includes(j.status)).length;
  const next = todays.find(j => ['booked', 'in_progress'].includes(j.status));
  const days = {};
  data.filter(j => j.scheduled_start.slice(0, 10) > t && ['booked', 'in_progress'].includes(j.status))
    .forEach(j => (days[j.scheduled_start.slice(0, 10)] ??= []).push(j));
  const areas = js => [...new Set(js.map(j => areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || j.properties?.suburb))].slice(0, 3).join(', ');
  const p = next?.properties || {};
  $('#homeBody').innerHTML = `
    <div class="card"><div class="muted">Today</div>
      ${todays.length ? `<div class="big">${todays.length - done} <span style="font-size:16px;font-weight:400">to go of ${todays.length}</span></div>
        <div class="bar"><i style="width:${Math.round(done / todays.length * 100)}%"></i></div>
        <div class="muted">${esc(areas(todays))}</div>
        <button class="primary" data-day="${t}" style="margin-top:10px">${done ? 'Continue' : 'Start'} today's run</button>`
      : '<p>No inspections booked today. Enjoy! 🙂</p>'}
    </div>
    ${next ? `<div class="card"><div class="muted">Next job</div><h3>${esc(p.address_line)}</h3><div class="muted">${esc(p.suburb)} ${esc(p.postcode)}</div>
      <div class="row"><button data-job="${next.id}">Open job</button>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.address_line}, ${p.suburb} QLD ${p.postcode || ''}`)}" target="_blank"><button style="width:100%">🧭 Navigate</button></a></div></div>` : ''}
    <h3 style="margin:16px 2px 8px">Coming up</h3>
    ${Object.keys(days).length ? Object.entries(days).map(([d, js]) => `<div class="card day" data-day="${d}">
        <div><b>${new Date(d + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' })}</b><div class="muted">${esc(areas(js))}</div></div>
        <div class="count">${js.length}</div></div>`).join('')
      : '<div class="card muted">Nothing else booked in the next 3 weeks yet.</div>'}`;
}
$('#homeBody').onclick = e => {
  const j = e.target.closest('[data-job]'); if (j) return openJob(j.dataset.job);
  const d = e.target.closest('[data-day]'); if (d) { day = d.dataset.day; loadRun(); }
};
$('#toHome').onclick = () => loadHome();

// ---------- today's run ----------
async function loadRun() {
  show('run'); msg('');
  $('#dayLabel').textContent = day === iso(new Date()) ? 'Today' : niceDate(day);
  const { data, error } = await sb.from('jobs')
    .select('id,job_type,status,route_order,notes,approved_at,property_id,properties(id,address_line,suburb,postcode,access_notes,clients(name))')
    .eq('inspector_id', inspectorId).gte('scheduled_start', day + 'T00:00').lte('scheduled_start', day + 'T23:59')
    .in('status', ['booked', 'in_progress', 'completed', 'no_access']).order('route_order', { nullsFirst: false });
  if (error) return msg(error.message);
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease', sale: 'Sale', install: 'Install', work_order: 'Work order', upgrade: 'Upgrade' };
  const left = data.filter(j => ['booked', 'in_progress'].includes(j.status)).length;
  $('#jobs').innerHTML = `<p class="muted">${data.length} jobs · ${left} to do</p>` + (data.map((j, i) => {
    const p = j.properties || {}, done = !['booked', 'in_progress'].includes(j.status);
    return `<div class="card ${done ? 'done' : ''}" data-job="${j.id}">
      <h3><span class="num">${i + 1}</span>${esc(p.address_line)}</h3>
      <div class="muted">${esc(p.suburb)} ${esc(p.postcode)} · ${esc(p.clients?.name)}
        <span class="tag">${label[j.job_type] || esc(j.job_type)}</span>${done ? `<span class="tag">${j.status === 'completed' ? (j.approved_at ? '✓ approved' : '✓ done – tap to edit') : 'no access'}</span>` : ''}</div>
      ${j.notes ? `<div style="margin-top:6px">${esc(j.notes)}</div>` : ''}
      ${p.access_notes ? `<div class="muted" style="margin-top:4px">${esc(p.access_notes)}</div>` : ''}
    </div>`;
  }).join('') || '<div class="card">No jobs booked for this day.</div>');
  runJobs = data; reordering = false; $('#reorder').textContent = '↕ Reorder';
}

// ---------- reorder ----------
let runJobs = [], reordering = false, movedId = null;
$('#reorder').onclick = async () => {
  if (!reordering) { reordering = true; movedId = null; $('#reorder').textContent = '✓ Save order'; return drawReorder(); }
  const todo = runJobs.filter(j => ['booked', 'in_progress'].includes(j.status)), done = runJobs.length - todo.length;
  $('#reorder').disabled = true;
  const res = await Promise.all(todo.map((j, i) => sb.from('jobs').update({ route_order: done + i + 1 }).eq('id', j.id)));
  $('#reorder').disabled = false; reordering = false; $('#reorder').textContent = '↕ Reorder';
  msg(res.find(r => r.error)?.error.message || ''); loadRun();
};
function drawReorder() {
  const todo = runJobs.filter(j => ['booked', 'in_progress'].includes(j.status));
  $('#jobs').innerHTML = '<p class="muted">Move jobs up or down, then tap Save order.</p>' + todo.map((j, i) => `<div class="card day${j.id === movedId ? ' moved' : ''}">
    <div><b>${i + 1}. ${esc(j.properties?.address_line)}</b><div class="muted">${esc(j.properties?.suburb)}</div></div>
    <div style="display:flex;gap:6px"><button data-mv="${i}" data-d="-1" ${i ? '' : 'disabled'}>▲</button><button data-mv="${i}" data-d="1" ${i < todo.length - 1 ? '' : 'disabled'}>▼</button></div></div>`).join('');
}
$('#jobs').addEventListener('click', e => {
  const b = e.target.closest('[data-mv]'); if (!b || !reordering) return;
  e.stopPropagation();
  const todo = runJobs.filter(j => ['booked', 'in_progress'].includes(j.status)), rest = runJobs.filter(j => !todo.includes(j));
  const i = +b.dataset.mv, k = i + +b.dataset.d;
  [todo[i], todo[k]] = [todo[k], todo[i]];
  movedId = todo[k].id; runJobs = [...rest, ...todo]; drawReorder();
  document.querySelector('#jobs .moved')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}, true);

$('#jobs').onclick = e => { const c = e.target.closest('[data-job]'); if (c) openJob(c.dataset.job); };
const shiftDay = n => { const d = new Date(day + 'T00:00'); d.setDate(d.getDate() + n); day = iso(d); loadRun(); };
$('#prevDay').onclick = () => shiftDay(-1);
$('#nextDay').onclick = () => shiftDay(1);

// ---------- one job ----------
// colour of each action button when picked: serviced green, replaced/moved blue, missing yellow, damaged/expired red
const actColour = a => /servic/i.test(a) ? 'act-g' : /replac|mov/i.test(a) ? 'act-b' : /missing/i.test(a) ? 'act-y' : /damag|expir/i.test(a) ? 'act-r' : '';
let lists = null;   // locations, device types, actions, quotes (from the Prices page)
async function loadLists() {
  if (lists) return;
  const { data } = await sb.from('price_items').select('kind,name').eq('active', true).order('sort');
  lists = { location: [], device_type: [], action: [], quote: [], replace_reason: [], extra: [] };
  (data || []).forEach(r => lists[r.kind]?.push(r.name));
}
const opts = (arr, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + arr.map(x => `<option${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('');
const today = () => iso(new Date());
const upload = async (file, name) => {
  msg('Uploading photo…');
  const path = `${companyId}/${job.id}/${name}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, file, { contentType: file.type || 'image/jpeg' });
  msg(error ? 'Photo upload failed: ' + error.message : '');
  return error ? null : path;
};

async function openJob(id, push = true) {
  if (push) history.pushState({ job: id }, '', '#job');
  show('job'); msg(''); $('#jobBody').innerHTML = '<p class="muted">Loading…</p>'; scrollTo(0, 0);
  await loadLists();
  const { data: j, error } = await sb.from('jobs')
    .select(`id,job_type,status,locked,approved_at,notes,tenant_note,property_id,outcome,outcome_notes,comment_photo,blind_cleats,blind_cleats_needed,safety_switch,safety_switch_notes,
      properties(address_line,suburb,postcode,access_notes,notes,storeys,bedrooms,ceiling_access,clients(name,notes)),
      alarm_checks(alarm_id,action,replace_reason,quote,photo_path)`).eq('id', id).single();
  if (error) return msg(error.message);
  const prev = {}; (j.alarm_checks || []).forEach(c => prev[c.alarm_id] = c);   // answers from an earlier save
  const ids = Object.keys(prev);
  const [{ data: alarms }, { data: ten }] = await Promise.all([
    sb.from('alarms').select('id,location,sensor_type,power_source,brand,manufacture_date,expiry_date')
      .eq('property_id', j.property_id).or(`active.eq.true${ids.length ? `,id.in.(${ids.join(',')})` : ''}`).order('location'),
    sb.from('tenancies').select('tenant_names,mobile,email,notes,tenant_notes,extra_phones').eq('property_id', j.property_id).order('lease_start', { ascending: false, nullsFirst: false }).limit(1)]);
  const p = j.properties || {};
  job = { ...j, tenant: ten?.[0] || {},
    extra: { ceiling_access: p.ceiling_access || '', storeys: p.storeys || '', bedrooms: p.bedrooms || '',
      blind_cleats: j.blind_cleats || '', blind_cleats_needed: j.blind_cleats_needed || '', safety_switch: j.safety_switch || '',
      safety_switch_notes: j.safety_switch_notes || '', comment: j.outcome_notes || '', comment_photo: j.comment_photo || '' },
    items: (alarms || []).map(a => { const c = prev[a.id] || {};
      return { alarm_id: a.id, location: a.location, device_type: cap(a.sensor_type), manufacture_date: a.manufacture_date,
        expiry_date: a.expiry_date, brand: a.brand, power_source: a.power_source, action: c.action || '', quote: c.quote || '',
        replace_reason: c.replace_reason || '', photo_path: c.photo_path || '',
        new_type: c.action === 'Replaced' ? cap(a.sensor_type) : '', new_date: c.action === 'Replaced' ? a.manufacture_date : '' }; }) };
  // unsaved progress from earlier on this phone (kept until Compliant/Non-compliant is saved)
  if (!job.locked && !job.approved_at) try {
    const d = JSON.parse(localStorage.getItem('draft:' + job.id) || 'null');
    if (d) { Object.assign(job.extra, d.extra); d.items.forEach(di => { const it = job.items.find(x => x.alarm_id === di.alarm_id); if (it) Object.assign(it, di); }); }
  } catch {}
  renderJob();
}
// save progress on this phone after every change – instant, and works without signal
const saveDraft = () => { if (!job || job.locked || job.approved_at) return;
  try { localStorage.setItem('draft:' + job.id, JSON.stringify({ at: Date.now(), extra: job.extra,
    items: job.items.map(({ alarm_id, action, quote, replace_reason, photo_path, new_type, new_date }) => ({ alarm_id, action, quote, replace_reason, photo_path, new_type, new_date })) })); } catch {} };
const dropDraft = id => { try { localStorage.removeItem('draft:' + id); } catch {} };
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';

function renderJob() {
  saveDraft();
  const p = job.properties || {}, t = job.tenant, x = job.extra;
  const editing = job.status === 'completed' && !job.approved_at && !job.locked;
  const done = !editing && (job.locked || !['booked', 'in_progress'].includes(job.status));
  const addr = encodeURIComponent(`${p.address_line}, ${p.suburb} QLD ${p.postcode || ''}`);
  const notes = [['Agent', p.clients?.notes], ['Property', p.notes], ['Keys / access', p.access_notes], ['Tenant', t.notes], ['From tenant (always)', t.tenant_notes], ['From tenant (this visit)', job.tenant_note], ['Other tenant phones', (t.extra_phones || []).join(', ')], ['Job', job.notes]].filter(n => n[1]);
  $('#jobBody').innerHTML = `
    <div class="card">
      <h3>${esc(p.address_line)}</h3><div class="muted">${esc(p.suburb)} ${esc(p.postcode)} · ${esc(p.clients?.name)}</div>
      <p><b>${esc(t.tenant_names || 'No tenant on file')}</b></p>
      <div class="row">
        ${t.mobile ? `<a href="tel:${esc(t.mobile.replace(/\s/g, ''))}"><button style="width:100%">📞 Call</button></a>` : ''}
        <a href="https://www.google.com/maps/dir/?api=1&destination=${addr}" target="_blank"><button style="width:100%">🧭 Navigate</button></a>
      </div>
    </div>
    <div class="card"><h3>Notes</h3>${notes.length ? notes.map(([k, v]) => `<p style="margin:6px 0"><b>${k}:</b> ${esc(v)}</p>`).join('') : '<p class="muted">No notes for this property.</p>'}</div>
    ${done ? `<div class="card">${job.approved_at ? '✓ This inspection has been approved by the office and can no longer be changed.' : `This job is ${esc(job.status.replace('_', ' '))}.`}</div>` : `
    ${editing ? `<div class="card" style="background:#e3f0ff">✓ Completed (${job.outcome === 'compliant' ? 'compliant' : 'non-compliant'}). You can still make changes until the office approves it.</div>` : ''}
    <h3>Alarms & devices (${job.items.length})</h3>
    ${job.items.map(itemCard).join('')}
    <div class="card" id="addBox">${job.adding ? addForm() : '<button class="primary" id="addOpen" style="background:#323f4b">➕ Add</button>'}</div>

    <div class="card"><h3>Blind cleats</h3>
      <div class="seg">${['Compliant', 'Needed', 'Installed'].map(v => `<button data-x="blind_cleats" data-v="${v}" class="${{ Compliant: 'act-g', Needed: 'act-y', Installed: 'act-b' }[v]}${x.blind_cleats === v ? ' on' : ''}">${v}</button>`).join('')}</div>
      ${['Needed', 'Installed'].includes(x.blind_cleats) ? `<label class="muted">How many ${x.blind_cleats === 'Needed' ? 'needed (quoted)' : 'installed (invoiced)'}?</label>
        <input type="number" min="1" data-xi="blind_cleats_needed" value="${esc(x.blind_cleats_needed || '')}">` : ''}
      <h3 style="margin-top:12px">Safety switch</h3>
      <div class="seg">${['Tested OK', 'Failed', 'No safety switch', 'Not tested'].map(v => `<button data-x="safety_switch" data-v="${v}" class="${{ 'Tested OK': 'act-g', Failed: 'act-r', 'No safety switch': 'act-r', 'Not tested': 'act-y' }[v]}${x.safety_switch === v ? ' on' : ''}">${v}</button>`).join('')}</div>
      ${x.safety_switch === 'Not tested' ? `<textarea rows="2" data-xi="safety_switch_notes" placeholder="Why wasn't it tested?">${esc(x.safety_switch_notes || '')}</textarea>` : ''}
    </div>

    <div class="card"><h3>Comments</h3>
      <textarea rows="3" data-xi="comment" placeholder="Anything the office or agent should know">${esc(x.comment || '')}</textarea>
      <label class="photo-btn">📷 ${x.comment_photo ? 'Retake photo' : 'Add photo'}<input type="file" accept="image/*" capture="environment" data-photo="comment" hidden></label>
      ${x.comment_photo ? '<span class="photo-ok">Photo saved ✓</span>' : ''}
    </div>

    <div class="card"><h3>Property details</h3>
      <label class="muted">Ceiling access</label><select data-xi="ceiling_access">${opts(['Easy', 'Limited', 'None'], x.ceiling_access, '—')}</select>
      <div class="row"><div><label class="muted">Levels</label><input type="number" min="1" data-xi="storeys" value="${esc(x.storeys)}"></div>
        <div><label class="muted">Bedrooms</label><input type="number" min="0" data-xi="bedrooms" value="${esc(x.bedrooms)}"></div></div>
    </div>

    <div class="finish">
      <button class="go" data-finish="compliant">✓ Compliant</button>
      <button class="stop" data-finish="non_compliant">✗ Non-compliant</button>
      <button class="warn" data-finish="no_access">No access</button>
    </div>`}`;
}

function itemCard(it, i) {
  const expired = it.expiry_date && it.expiry_date < today();
  return `<div class="card">
    <h3>${esc(it.location)} <span class="tag">${esc(it.device_type || '?')}</span>${it.alarm_id ? '' : ' <span class="tag">new</span>'}</h3>
    <div class="muted">${esc(it.brand || '')} ${it.manufacture_date ? 'made ' + esc(it.manufacture_date.slice(0, 7)) : ''}
      ${it.expiry_date ? `<span class="${expired ? 'bad' : ''}">· expires ${esc(it.expiry_date.slice(0, 7))}${expired ? ' – EXPIRED' : ''}</span>` : ''}</div>
    <div class="seg">${lists.action.map(a => `<button data-i="${i}" data-act="${esc(a)}" class="${actColour(a)}${it.action === a ? ' on' : ''}">${esc(a)}</button>`).join('')}</div>
    ${it.action === 'Replaced' ? `<div class="replace">
      <label class="muted">Why was it replaced?</label><select data-i="${i}" data-f="replace_reason">${opts(lists.replace_reason, it.replace_reason, 'Choose reason')}</select>
      <label class="muted">New device type</label><select data-i="${i}" data-f="new_type">${opts(lists.device_type, it.new_type, 'Choose type')}</select>
      <label class="muted">New manufacture date</label><input type="month" data-i="${i}" data-f="new_date" value="${esc((it.new_date || '').slice(0, 7))}"></div>` : ''}
    <label class="muted">Quote</label><select data-i="${i}" data-f="quote">${opts(lists.quote, it.quote, 'No quote')}</select>
    <label class="photo-btn">📷 ${it.photo_path ? 'Retake photo' : 'Photo'}<input type="file" accept="image/*" capture="environment" data-photo="${i}" hidden></label>
    ${it.photo_path ? '<span class="photo-ok">Photo saved ✓</span>' : ''}
    ${it.alarm_id ? '' : `<button class="link" data-remove="${i}">Remove</button>`}
  </div>`;
}

function addForm() {
  const n = job.adding;
  return `<h3>Add an alarm or device</h3>
    <label class="muted">Location</label><select id="adLoc">${opts(lists.location, n.location, 'Choose location')}</select>
    <label class="muted">Type</label><select id="adType">${opts(lists.device_type, '', 'Choose type')}</select>
    <label class="muted">Manufacture date</label><input id="adDate" type="month">
    <label class="muted">Action</label><select id="adAct">${opts(lists.action, '', 'Choose action')}</select>
    <label class="muted">Quote</label><select id="adQuote">${opts(lists.quote, '', 'No quote')}</select>
    <div class="row"><button class="primary" id="adSave">Add</button><button id="adCancel">Cancel</button></div>`;
}

$('#jobBody').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.act) { const it = job.items[+t.dataset.i]; it.action = it.action === t.dataset.act ? '' : t.dataset.act; return renderJob(); }
  if (t.dataset.x) { job.extra[t.dataset.x] = t.dataset.v; return renderJob(); }
  if (t.dataset.remove) { job.items.splice(+t.dataset.remove, 1); return renderJob(); }
  if (t.id === 'addOpen') { job.adding = {}; renderJob(); return $('#addBox').scrollIntoView({ block: 'center' }); }
  if (t.id === 'adCancel') { job.adding = null; return renderJob(); }
  if (t.id === 'adSave') {
    if (!$('#adLoc').value || !$('#adType').value || !$('#adAct').value) return msg('Choose a location, type and action');
    job.items.push({ alarm_id: null, location: $('#adLoc').value, device_type: $('#adType').value, manufacture_date: $('#adDate').value ? $('#adDate').value + '-01' : '',
      action: $('#adAct').value, quote: $('#adQuote').value });
    job.adding = null; msg(''); return renderJob();
  }
  if (t.dataset.finish) return finish(t.dataset.finish, t);
});

// typing in comments/notes is saved as you type
$('#jobBody').addEventListener('input', e => { const t = e.target;
  if (t.dataset.xi && t.matches('textarea,input[type=text],input:not([type])')) { job.extra[t.dataset.xi] = t.value; saveDraft(); } });
$('#jobBody').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.f) { const it = job.items[+t.dataset.i]; it[t.dataset.f] = t.type === 'month' ? t.value + '-01' : t.value; return saveDraft(); }
  if (t.dataset.xi) { job.extra[t.dataset.xi] = t.value; return saveDraft(); }
  if (t.dataset.photo && t.files[0]) {
    const isComment = t.dataset.photo === 'comment';
    const lbl = t.closest('label'); lbl.nextElementSibling?.classList.contains('photo-ok') && lbl.nextElementSibling.remove();
    lbl.insertAdjacentHTML('afterend', '<span class="photo-busy">Uploading…</span>');   // until the tick appears
    const path = await upload(t.files[0], isComment ? 'comment' : 'item' + t.dataset.photo);
    if (!path) { lbl.parentNode.querySelector('.photo-busy')?.remove(); return; }
    if (isComment) job.extra.comment_photo = path; else job.items[+t.dataset.photo].photo_path = path;
    renderJob();
  }
});

async function finish(outcome, btn) {
  if (outcome === 'no_access') {
    const why = prompt('Why was there no access? (e.g. no one home, keys didn\'t work)'); if (!why) return;
    const { error } = await sb.from('jobs').update({ status: 'no_access', outcome: 'no_access', outcome_notes: why }).eq('id', job.id);
    if (error) return msg(error.message);
    alert('Marked as no access – the office will rebook'); return backToRun();
  }
  const noAction = job.items.filter(it => !it.action);
  if (noAction.length && !confirm(`${noAction.length} item(s) have no action chosen. Finish anyway?`)) return;
  if (!job.extra.blind_cleats || !job.extra.safety_switch) return msg('Please answer the blind cleats and safety switch questions');
  if (['Needed', 'Installed'].includes(job.extra.blind_cleats) && !job.extra.blind_cleats_needed) return msg('Enter how many blind cleats');
  const badRep = job.items.find(it => it.action === 'Replaced' && (!it.replace_reason || !it.new_type));
  if (badRep) return msg(`${badRep.location}: choose why it was replaced and the new device type`);
  if (!confirm(outcome === 'compliant' ? 'Issue a COMPLIANT certificate?' : 'Mark as NON-COMPLIANT?')) return;
  btn.disabled = true;
  const items = job.items.map(it => {
    const rep = it.action === 'Replaced';
    return { alarm_id: it.alarm_id, location: it.location, action: it.action, quote: it.quote, photo_path: it.photo_path,
      replace_reason: rep ? it.replace_reason : null,
      device_type: rep ? it.new_type : it.device_type, manufacture_date: rep ? (it.new_date || '') : it.manufacture_date };
  });
  const { data: cert, error } = await sb.rpc('complete_job', { p_job: job.id, p_items: items, p_outcome: outcome, p_extra: job.extra });
  btn.disabled = false;
  if (error) return msg(error.message);
  dropDraft(job.id);
  alert(`${job.status === 'completed' ? 'Changes saved' : 'Done'} ✓ Certificate ${cert} (${outcome === 'compliant' ? 'compliant' : 'NOT compliant'})`);
  backToRun();
}

// phone/browser back button returns to the run instead of leaving the app
const backToRun = () => { if (history.state?.job) history.back(); else loadRun(); };
$('#back').onclick = backToRun;
window.addEventListener('popstate', () => loadRun());

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

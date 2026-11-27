// AlarmRun office app. Loaded by index.html after supabase-js and config.js.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const PAGE = 50;
let companyId = null, tab = 'clients', page = 0, term = '';
const $ = s => document.querySelector(s);
const show = id => { ['login','setup','app'].forEach(s => $('#'+s).classList.toggle('hidden', s !== id)); document.querySelector('body>h1').hidden = id === 'app'; };
const msg = t => $('#msg').textContent = t || '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const get = (r, p) => p.split('.').reduce((o, k) => o && o[k], r);
const date = v => v ? String(v).slice(0,10) : '';
const leaseEnd = v => { if (!v) return ''; const days = Math.round((new Date(v) - new Date()) / 864e5);
  return esc(date(v)) + (days < 0 ? ' <span class=bad>(ended)</span>' : days <= 60 ? ` <span class=bad>(${days} days)</span>` : ''); };
// photo: site path (img/...) or private storage path -> url
const photoUrls = async paths => { const st = [...new Set(paths.filter(p => p && !p.startsWith('img/')))]; const m = {};
  if (st.length) { const { data } = await sb.storage.from('photos').createSignedUrls(st, 3600); (data || []).forEach((d, i) => m[st[i]] = d.signedUrl); }
  return p => !p ? '' : p.startsWith('img/') ? p : m[p] || ''; };
const shrink = (file, max = 1280) => new Promise(res => { const img = new Image(); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  c.toBlob(res, 'image/jpeg', 0.8); }; img.src = URL.createObjectURL(file); });
const money = v => v == null ? '' : '$' + Number(v).toFixed(2);

// What each tab lists, what it searches, how it sorts
const views = {
  clients: { table:'clients', select:'id,name,type,billing_email,phone', search:'name', order:'name', asc:true,
    cols:[['Name','name'],['Type','type'],['Billing email','billing_email'],['Phone','phone']] },
  properties: { table:'properties', select:'id,address_line,suburb,postcode,photo,clients(name),tenancies(tenant_names,owner_occupied,lease_start)', search:'address_line', order:'address_line', asc:true, click:true,
    after: async rows => { const { data } = await sb.from('property_due').select('id,last_done,due_date').in('id', rows.map(r => r.id));
      const m = Object.fromEntries((data || []).map(d => [d.id, d])); const url = await photoUrls(rows.map(r => r.photo)); rows.forEach(r => { r.last_done = m[r.id]?.last_done; r.due = m[r.id]?.due_date; r.pic = url(r.photo); }); },
    cols:[['Address','*',r => `<div class="addr">${r.pic ? `<img class="thumb" src="${r.pic}" alt="">` : '<span class="thumb"></span>'}${esc(r.address_line)}, ${esc(r.suburb || '')} ${esc(r.postcode || '')}</div>`,'html'],['Agency / owner','clients.name'],
      ['Tenant','tenancies',t => { const x = [...(t || [])].sort((a, b) => String(b.lease_start).localeCompare(String(a.lease_start)))[0]; return x ? x.tenant_names + (x.owner_occupied ? ' (owner)' : '') : ''; }],
      ['Last inspected','last_done',date],['Next due','due',date]] },
  tenants: { table:'tenancies', select:'id,tenant_names,mobile,email,lease_start,lease_end,vacate_date,property_id,properties!inner(address_line,suburb)', search:'tenant_names', order:'lease_end', asc:false, click:'property_id',
    cols:[['Address','properties.address_line'],['Suburb','properties.suburb'],['Tenants','tenant_names'],['Mobile','mobile'],['Email','email'],['Lease start','lease_start',date],['Lease end','lease_end',leaseEnd,'html'],['Vacate','vacate_date',date]] },
  inspectors: { table:'inspectors', select:'name,email,phone,base_suburb,daily_capacity,active', search:'name', order:'name', asc:true,
    cols:[['Name','name'],['Email','email'],['Phone','phone'],['Home suburb','base_suburb'],['Jobs/day','daily_capacity'],['Active','active']] },
  jobs: { table:'jobs', select:'id,job_type,status,scheduled_start,notes,locked,inspectors(name),properties!inner(address_line,suburb)', search:'properties.address_line', order:'scheduled_start', asc:false,
    cols:[['Date','scheduled_start',date],['Address','properties.address_line'],['Suburb','properties.suburb'],['Type','job_type'],['Inspector','inspectors.name'],['Status','status',null,'status'],['Notes','notes']] },
  certificates: { table:'certificates', select:'number,compliant,issued_at,jobs!inner(properties!inner(address_line,suburb))', search:'number', order:'issued_at', asc:false,
    cols:[['Number','number'],['Issued','issued_at',date],['Address','jobs.properties.address_line'],['Suburb','jobs.properties.suburb'],['Result','compliant',v => v ? '<span class=good>Compliant</span>' : '<span class=bad>Not compliant</span>', 'html']] },
  invoices: { table:'invoices', select:'number,amount_ex_gst,gst,status,due_date,clients(name)', search:'number', order:'due_date', asc:false,
    cols:[['Number','number'],['Client','clients.name'],['Ex GST','amount_ex_gst',money],['GST','gst',money],['Status','status'],['Due','due_date',date]] },
};

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('login');
  $('#who').textContent = session.user.email;
  const { data, error } = await sb.from('memberships').select('company_id,companies(name)').limit(1);
  if (error) { msg(error.message); return show('setup'); }
  if (!data.length) return show('setup');
  companyId = data[0].company_id;
  $('#who').textContent = `${data[0].companies?.name || ''} · ${session.user.email}`;
  document.title = `${data[0].companies?.name || 'AlarmRun'} – Office`;
  show('app');
  loadClientPick();
  document.querySelector('aside button[data-tab="home"]').click();
}

async function loadList() {
  const v = views[tab];
  let q = sb.from(v.table).select(v.select, { count: 'exact' })
    .order(v.order, { ascending: v.asc, nullsFirst: false })
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (term) q = q.ilike(v.search, `%${term}%`);
  const { data, count, error } = await q;
  if (error) return msg(error.message);
  if (v.after && data.length) await v.after(data);
  msg('');
  const pages = Math.max(1, Math.ceil((count || 0) / PAGE));
  $('#pageInfo').textContent = ` Page ${page + 1} of ${pages} (${count} records) `;
  $('#prev').disabled = page === 0; $('#next').disabled = page + 1 >= pages;
  $('#list').innerHTML = '<tr>' + v.cols.map(c => `<th>${c[0]}</th>`).join('') + '</tr>' +
    data.map(r => `<tr${v.click ? ` class="click" data-id="${v.click === true ? r.id : r[v.click]}"` : ''}>` + v.cols.map(([, path, fmt, kind]) => {
      const val = path === '*' ? r : get(r, path);
      if (kind === 'status' && !r.locked)
        return `<td><select data-job="${r.id}">${['to_book','booked','in_progress','completed','cancelled','no_access'].map(s => `<option${s===val?' selected':''}>${s}</option>`).join('')}</select></td>`;
      const out = fmt ? fmt(val) : val;
      return `<td>${kind === 'html' ? out : esc(out)}</td>`;
    }).join('') + '</tr>').join('');
}

// Property detail: info + alarms + history
async function openProperty(id) {
  $('#listArea').classList.add('hidden'); $('#detail').classList.remove('hidden');
  document.querySelectorAll('.tab form').forEach(f => f.classList.add('hidden'));
  const [{ data: p }, { data: alarms }, { data: jobs }, { data: ten }] = await Promise.all([
    sb.from('properties').select('*,clients(name)').eq('id', id).single(),
    sb.from('alarms').select('*').eq('property_id', id).order('location'),
    sb.from('jobs').select('job_type,status,scheduled_start,notes,certificates(number,compliant)').eq('property_id', id).order('scheduled_start', { ascending: false }),
    sb.from('tenancies').select('*').eq('property_id', id).order('lease_start', { ascending: false, nullsFirst: false }),
  ]);
  const today = new Date().toISOString().slice(0,10);
  const pic = (await photoUrls([p.photo]))(p.photo);
  $('#detailBody').innerHTML = `
    <div class="phead">${pic ? `<img src="${pic}" alt="">` : '<div class="nophoto">🏠</div>'}
      <label class="photobtn"><input type="file" accept="image/*" id="propPhoto" hidden>📷 ${pic ? 'Change' : 'Add'} photo</label></div>
    <h2>${esc(p.address_line)}, ${esc(p.suburb)} ${esc(p.postcode)}</h2>
    <p><b>Agency:</b> ${esc(p.clients?.name)} &nbsp; <b>Next due:</b> ${date(p.next_due)}<br>
    <b>Notes:</b> ${esc(p.access_notes)}</p>
    <form id="propNotesForm" style="display:block"><b>Property notes for inspectors</b><br>
      <textarea name="notes" rows="2" style="width:100%;box-sizing:border-box">${esc(p.notes || '')}</textarea>
      <button>Save notes</button></form>
    <form id="breakdownForm"><select name="job_type"><option value="callout">Breakdown</option><option value="work_order">Work order</option><option value="upgrade">Upgrade</option><option value="pre_tenancy">Lease</option><option value="sale">Sale</option><option value="install">Install</option></select>
      <input name="notes" placeholder="Details e.g. hallway alarm beeping" size="45" required><button>Log job</button></form>
    <h3>Tenancies (${ten.length})</h3>
    <table><tr><th>Tenants</th><th>Mobile</th><th>Email</th><th>Notices by</th><th>Move in</th><th>Lease</th><th>Vacate</th><th>PM</th></tr>
    ${ten.map(t => `<tr><td>${esc(t.tenant_names)}${t.owner_occupied ? ' <span class="tag">Owner occupied</span>' : ''}</td><td>${esc(t.mobile)}</td><td>${esc(t.email)}</td><td><select data-noticeby="${t.id}"><option value="email"${t.notice_by !== 'mail' ? ' selected' : ''}>Email</option><option value="mail"${t.notice_by === 'mail' ? ' selected' : ''}>Mail</option></select></td><td>${date(t.move_in)}</td>
      <td>${date(t.lease_start)} → ${leaseEnd(t.lease_end)}</td><td>${date(t.vacate_date)}</td><td>${esc(t.property_manager)}</td></tr>`).join('')}</table>
    <form id="tenForm">
      <input name="tenant_names" placeholder="Tenant name(s)" required>
      <input name="mobile" placeholder="Mobile">
      <input name="email" type="email" placeholder="Email">
      <label>Lease start <input name="lease_start" type="date"></label>
      <label>Lease end <input name="lease_end" type="date"></label>
      <label><input name="owner_occupied" type="checkbox" value="true" style="width:auto"> Owner occupied</label>
      <button>Add tenancy</button>
    </form>
    <h3>Alarms (${alarms.length})</h3>
    <table><tr><th>Location</th><th>Type</th><th>Power</th><th>Brand</th><th>Expires</th></tr>
    ${alarms.map(a => `<tr><td>${esc(a.location)}</td><td>${esc(a.sensor_type)}</td><td>${esc(a.power_source)}</td><td>${esc(a.brand)}</td>
      <td class="${a.expiry_date && a.expiry_date < today ? 'bad' : ''}">${date(a.expiry_date)}</td></tr>`).join('')}</table>
    <form id="alarmForm">
      <input name="location" placeholder="Location e.g. Bedroom 1" required>
      <select name="sensor_type"><option>photoelectric</option><option>ionisation</option><option>heat</option><option>other</option></select>
      <select name="power_source"><option>hardwired</option><option>10yr_lithium</option><option>9v</option><option>other</option></select>
      <input name="brand" placeholder="Brand">
      <input name="manufacture_date" type="date" title="Manufacture date">
      <button>Add alarm</button>
    </form>
    <h3>Inspection history (${jobs.length})</h3>
    <table><tr><th>Date</th><th>Type</th><th>Status</th><th>Certificate</th><th>Notes</th></tr>
    ${jobs.map(j => { const c = j.certificates?.[0] || j.certificates; return `<tr><td>${date(j.scheduled_start)}</td><td>${esc(j.job_type)}</td><td>${esc(j.status)}</td>
      <td>${c?.number ? esc(c.number) + (c.compliant ? ' <span class=good>✓</span>' : ' <span class=bad>✗</span>') : ''}</td><td>${esc(j.notes)}</td></tr>`; }).join('')}</table>`;
  $('#detailBody').querySelectorAll('[data-noticeby]').forEach(sel => sel.onchange = async () => {
    const { error } = await sb.from('tenancies').update({ notice_by: sel.value }).eq('id', sel.dataset.noticeby);
    msg(error ? error.message : `Entry notices for this tenancy will go by ${sel.value} (applies to new bookings)`);
  });
  $('#propPhoto').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; msg('Uploading photo…');
    const path = `${companyId}/property/${id}-${Date.now()}.jpg`;
    const { error } = await sb.storage.from('photos').upload(path, await shrink(f), { contentType: 'image/jpeg' });
    if (error) return msg(error.message);
    const { error: e2 } = await sb.from('properties').update({ photo: path }).eq('id', id);
    msg(e2 ? e2.message : 'Photo saved'); openProperty(id);
  };
  $('#propNotesForm').onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.from('properties').update({ notes: e.target.notes.value || null }).eq('id', id);
    msg(error ? error.message : 'Property notes saved');
  };
  $('#breakdownForm').onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.from('jobs').insert({ company_id: companyId, property_id: id, job_type: e.target.job_type.value, status: 'to_book', notes: e.target.notes.value });
    if (error) return msg(error.message);
    msg('Job logged – it is now on Due'); openProperty(id);
  };
  $('#tenForm').onsubmit = async e => {
    e.preventDefault();
    const row = { company_id: companyId, property_id: id };
    for (const [k, v] of new FormData(e.target)) if (v !== '') row[k] = v;
    const { error } = await sb.from('tenancies').insert(row);
    if (error) return msg(error.message);
    msg('Tenancy added'); openProperty(id);
  };
  $('#alarmForm').onsubmit = async e => {
    e.preventDefault();
    const row = { company_id: companyId, property_id: id };
    for (const [k, v] of new FormData(e.target)) if (v !== '') row[k] = v;
    const { error } = await sb.from('alarms').insert(row);
    if (error) return msg(error.message);
    openProperty(id);
  };
}

async function loadClientPick() {
  const { data } = await sb.from('clients').select('id,name').order('name');
  document.querySelectorAll('.clientPick').forEach(s =>
    s.innerHTML = '<option value="">— client —</option>' + (data||[]).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''));
}

// Address search for the job form
let propMatches = {};
document.querySelectorAll('.propSearch').forEach(inp => inp.addEventListener('input', async e => {
  const t = e.target.value, hidden = e.target.form.property_id;
  hidden.value = propMatches[t] || '';
  if (t.length < 3 || propMatches[t]) return;
  const { data } = await sb.from('properties').select('id,address_line,suburb').ilike('address_line', `%${t}%`).limit(20);
  propMatches = {};
  $('#propList').innerHTML = (data||[]).map(p => { const label = `${p.address_line}, ${p.suburb}`; propMatches[label] = p.id; return `<option value="${esc(label)}">`; }).join('');
}));

// ---------- Scheduling ----------
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;  // local date
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const keyOf = r => r.job_id || 'p:' + r.property_id;
let inspectors = [], areaOf = {}, weekStart = null;
const ticked = { due: new Set(), ready: new Set(), day: new Set() };
let dueRows = new Map();
const staged = new Map();      // rows moved to Book
try { for (const [k, v] of JSON.parse(localStorage.getItem('staged2') || '[]')) staged.set(k, v); } catch {}
const saveStaged = () => { try { localStorage.setItem('staged2', JSON.stringify([...staged])); } catch {} };

async function openSchedule() {
  const f = $('#dueFilter');
  if (!f.by.value) f.by.value = addDays(14);
  if (!weekStart) weekStart = planWeek(14);
  if (!inspectors.length) {
    const [{ data: ins }, { data: areas }] = await Promise.all([
      sb.from('inspectors').select('id,name,daily_capacity').eq('active', true).order('name'),
      sb.from('suburb_areas').select('suburb,area')]);
    inspectors = ins || [];
    (areas || []).forEach(a => areaOf[a.suburb] = a.area);
    drawInsFilter();
    await loadOverrides();
  }
  if (tab === 'due') loadDue(); else { if (tab === 'book') renderReady(); dayTicked.clear(); loadWeek(); }
}

// Grouped table used by both Due and Ready to book
// heading boxes: ticked only if everything under them is ticked
function syncHeads(el) {
  el.querySelectorAll('[data-group]').forEach(h => {
    const kids = [...el.querySelectorAll('.pick.' + h.dataset.group)], on = kids.filter(c => c.checked).length;
    h.checked = kids.length > 0 && on === kids.length; h.indeterminate = false;   // partly ticked headings stay empty
  });
}
function renderGrouped(rows, el, which, groupBy) {
  const today = iso(new Date()), keys = groupBy.split(',');
  const n = o => Array.isArray(o) ? o.length : Object.values(o).reduce((t, v) => t + n(v), 0);
  const order = (o, key) => key === 'reason'
    ? ['Breakdown', 'Annual'].filter(x => o[x]).concat(Object.keys(o).filter(x => !['Breakdown', 'Annual'].includes(x)))
    : Object.keys(o).sort((x, y) => n(o[y]) - n(o[x]));
  const tree = {};
  for (const r of rows) {
    let node = tree;
    keys.forEach((k, i) => { const v = r[k] || '—'; node = node[v] ??= (i === keys.length - 1 ? [] : {}); });
    node.push(r);
  }
  const cls = ['g0', 'g1', 'g2'];
  let html = '<tr><th></th><th>Address</th><th>Reason</th><th>Last done</th><th>Due</th><th>Notes</th></tr>', gi = 0;
  const walk = (node, lvl, ids) => {
    for (const k of order(node, keys[lvl])) {
      const id = which + (gi++), child = node[k], all = [...ids, id];
      html += `<tr class="${cls[lvl]}"><td><input type="checkbox" data-group="${id}"></td><td colspan="5" data-focus="${id}" data-label="${esc(k)}">${'&nbsp;&nbsp;'.repeat(lvl)}${esc(k)} — ${n(child)}</td></tr>`;
      if (Array.isArray(child)) {
        child.sort((x, y) => (x.suburb || '').localeCompare(y.suburb || '') || x.address_line.localeCompare(y.address_line));
        html += child.map(r => `<tr class="prow"><td><input type="checkbox" class="pick ${all.join(' ')}" data-key="${keyOf(r)}"${ticked[which].has(keyOf(r)) ? ' checked' : ''}></td>
          <td>${esc(r.address_line)}, ${esc(r.suburb)}</td><td><span class="why why-${esc((r.reason || 'other').toLowerCase().replace(/\s+/g, '-'))}">${esc(r.reason || 'Other')}</span></td><td>${date(r.last_done)}</td>
          <td class="${r.due_date && r.due_date < today ? 'bad' : ''}">${date(r.due_date)}</td><td>${esc(r.notes)}</td></tr>`).join('');
      } else walk(child, lvl + 1, all);
    }
  };
  walk(tree, 0, []);
  el.innerHTML = rows.length ? html : '<tr><td>Nothing here.</td></tr>';
  el.onchange = e => {
    const g = e.target.dataset.group;
    const boxes = g ? [...el.querySelectorAll('.pick.' + g)] : e.target.classList.contains('pick') ? [e.target] : [];
    boxes.forEach(c => { c.checked = e.target.checked; c.checked ? ticked[which].add(c.dataset.key) : ticked[which].delete(c.dataset.key); });
    syncHeads(el);
    if (which === 'ready' && g) focusGroup = g;
    counts(); if (which === 'ready') showProps();
  };
  if (which === 'day') el.onclick = e => {
    const id = e.target.closest('[data-focus]')?.dataset.focus; if (!id) return;
    const rows = [...el.querySelectorAll('.pick.' + id)].map(c => c.closest('tr'));
    const open = !rows[0]?.classList.contains('show');
    rows.forEach(tr => tr.classList.toggle('show', open));
  };
  if (which === 'ready') {
    el.onclick = e => { const id = e.target.closest('[data-focus]')?.dataset.focus; if (id) { focusGroup = id; showProps(); } };
    showProps();
  }
  syncHeads(el); counts();
}

// Right half of Book: the properties in the agent/area you clicked
let focusGroup = null;
function showProps() {
  const left = $('#readyList'), head = left.querySelector(`[data-focus="${focusGroup}"]`);
  left.querySelectorAll('tr.focus').forEach(tr => tr.classList.remove('focus'));
  if (!head) { $('#readyProps').innerHTML = ''; $('#propsHead').textContent = 'Tick or click an agent or area to see its properties'; return; }
  head.parentElement.classList.add('focus');
  const today = iso(new Date());
  const rows = [...left.querySelectorAll('.pick.' + focusGroup)].map(c => readyRows.get(c.dataset.key)).filter(Boolean);
  $('#propsHead').textContent = head.dataset.label;
  $('#readyProps').innerHTML = '<tr><th></th><th>Address</th><th>Last done</th><th>Due</th><th>Notes</th></tr>' + rows.map(r =>
    `<tr class="prow"><td><input type="checkbox" data-key="${keyOf(r)}"${ticked.ready.has(keyOf(r)) ? ' checked' : ''}></td>
     <td>${esc(r.address_line)}, ${esc(r.suburb)}</td><td>${date(r.last_done)}</td>
     <td class="${r.due_date && r.due_date < today ? 'bad' : ''}">${date(r.due_date)}</td><td>${esc(r.notes)}</td></tr>`).join('');
}
$('#readyProps').onchange = e => {
  const k = e.target.dataset.key; if (!k) return;
  e.target.checked ? ticked.ready.add(k) : ticked.ready.delete(k);
  const twin = $('#readyList').querySelector(`.pick[data-key="${k}"]`); if (twin) twin.checked = e.target.checked;
  syncHeads($('#readyList'));
  counts();
};

function counts() {
  if (tab === 'scheduled') showTicked();
  $('#dueCount').textContent = `${ticked.due.size} ticked`;
  $('#readyHead').textContent = `Ready to book — ${readyRows.size} (${ticked.ready.size} ticked)`;
}

async function loadDue() {
  const f = $('#dueFilter');
  let q = sb.from('schedule_queue').select('reason,property_id,job_id,address_line,suburb,postcode,agency,area,last_done,due_date,notes')
    .lte('due_date', f.by.value).order('due_date').limit(3000);
  const a = f.area.value.trim();
  if (a) q = /^\d+$/.test(a) ? q.eq('postcode', a) : q.or(`area.ilike.%${a}%,suburb.ilike.%${a}%`);
  const { data, error } = await q;
  if (error) return msg(error.message);
  const rows = data.filter(r => !staged.has(keyOf(r)));
  dueRows = new Map(rows.map(r => [keyOf(r), r]));
  $('#dueInfo').textContent = `${rows.length} waiting` + (staged.size ? ` · ${staged.size} on Book` : '');
  renderGrouped(rows, $('#dueList'), 'due', f.group.value);
}

// Ready to book = what you moved from Due + any open jobs that have no inspector yet
let readyRows = new Map();
const drawReady = () => renderGrouped([...readyRows.values()], $('#readyList'), 'ready', 'agency,area');
async function renderReady() {
  const { data, error } = await sb.from('jobs')
    .select('id,property_id,job_type,status,scheduled_start,notes,properties(address_line,suburb,postcode,clients(name))')
    .is('inspector_id', null).in('status', ['to_book', 'booked']).limit(2000);
  if (error) return msg(error.message);
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease', sale: 'Sale', install: 'Install', work_order: 'Work order', upgrade: 'Upgrade' };
  const unassigned = data.filter(j => j.status !== 'to_book')   // logged jobs live on Due
    .map(j => ({ reason: label[j.job_type] || 'Other', property_id: j.property_id, job_id: j.id,
      address_line: j.properties?.address_line || '', suburb: j.properties?.suburb || '', postcode: j.properties?.postcode,
      agency: j.properties?.clients?.name, area: areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || 'No area',
      last_done: null, due_date: j.scheduled_start ? j.scheduled_start.slice(0,10) : null,
      notes: [j.scheduled_start ? 'Unassigned job' : 'Unbooked job', j.notes].filter(Boolean).join(' – ') }));
  readyRows = new Map([...staged, ...unassigned.map(r => [keyOf(r), r])]);
  drawReady();
}

$('#toBook').onclick = () => {
  if (!ticked.due.size) return msg('Tick some properties first');
  const n = ticked.due.size;
  for (const k of ticked.due) if (dueRows.has(k)) staged.set(k, dueRows.get(k));
  ticked.due.clear(); saveStaged(); loadDue();
  msg(`Moved ${n} to Book`);
};
$('#backToDue').onclick = () => {
  if (!ticked.ready.size) return msg('Tick some on the Ready to book list first');
  const jobs = [...ticked.ready].filter(k => !staged.has(k));
  for (const k of ticked.ready) staged.delete(k);
  if (jobs.length) msg('Unassigned jobs stay here – cancel them on the Jobs page if not needed');
  else msg('Sent back to Due');
  ticked.ready.clear(); saveStaged(); renderReady();
};

// Put an inspector's day in a sensible order: postcode → suburb → street → house number
async function orderDay(insId, day) {
  const { data } = await sb.from('jobs').select('id,properties(address_line,suburb,postcode)').eq('inspector_id', insId)
    .gte('scheduled_start', day + 'T00:00').lte('scheduled_start', day + 'T23:59').in('status', ['booked', 'in_progress']);
  if (!data?.length) return;
  const key = j => { const p = j.properties || {}, a = (p.address_line || '').trim();
    const street = a.replace(/^[\d\s/,-]+[a-z]?\s+/i, '').toLowerCase(), num = parseInt(a.split('/').pop()) || 0;
    return [p.postcode || '9999', (p.suburb || '').toLowerCase(), street, String(num).padStart(6, '0'), a].join('|'); };
  data.sort((x, y) => key(x).localeCompare(key(y)));
  await Promise.all(data.map((j, i) => sb.from('jobs').update({ route_order: i + 1 }).eq('id', j.id)));
}

// selected board cell (the From day on Scheduled)
const pick = { ins: '', day: '' };
const onBoard = (ins, day) => [...weekJobs, ...week2Jobs].filter(j => j.ins === ins && j.day === day).length;   // jobs already on that day

$('#dueFilter').onsubmit = e => { e.preventDefault(); loadDue(); };
$('#dueFilter').group.onchange = loadDue;

async function bookTicked() {
  const picks = [...ticked.ready].map(k => readyRows.get(k)).filter(Boolean);
  if (!picks.length) return msg('Tick some on the Ready to book list first');
  const insId = pick.ins, day = pick.day, when = `${day}T09:00:00`;
  // step 1: update the screen straight away
  for (const r of picks) {
    readyRows.delete(keyOf(r)); staged.delete(keyOf(r));
    weekJobs.push({ id: null, ins: insId, day, area: r.area || 'No area', agent: r.agency || 'No agent' });
  }
  ticked.ready.clear(); saveStaged(); drawReady(); drawWeek();
  msg(`Booking ${picks.length}…`);
  // step 2: save, then refresh from the database
  const fresh = picks.filter(r => !r.job_id).map(r => ({ company_id: companyId, property_id: r.property_id, job_type: 'annual',
    status: 'booked', inspector_id: insId, scheduled_start: when }));
  const jobIds = picks.filter(r => r.job_id).map(r => r.job_id);
  const results = await Promise.all([
    fresh.length ? sb.from('jobs').insert(fresh) : {},
    jobIds.length ? sb.from('jobs').update({ status: 'booked', inspector_id: insId, scheduled_start: when }).in('id', jobIds) : {}]);
  const err = results.find(r => r.error)?.error;
  if (!err) await orderDay(insId, day);
  msg(err ? 'Booking failed: ' + err.message : `Booked ${picks.length}`);
  Promise.all([renderReady(), loadWeek()]);
}

// Week board: inspectors down, days across; each cell = total + areas (count)
// ---- availability: weekdays available, weekends not, unless a date has been changed (inspector_days) ----
let dayOverrides = {};   // 'inspectorId|YYYY-MM-DD' → true/false
const isWeekday = d => { const w = new Date(d + 'T00:00').getDay(); return w > 0 && w < 6; };
const isAvailable = (ins, d) => { const o = dayOverrides[(ins?.id) + '|' + d]; return o ?? isWeekday(d); };
async function loadOverrides() {
  const from = addDays(-14), to = addDays(180);
  const { data } = await sb.from('inspector_days').select('inspector_id,day,available').gte('day', from).lte('day', to);
  dayOverrides = {}; (data || []).forEach(r => dayOverrides[r.inspector_id + '|' + r.day] = r.available);
}
// ---- which inspectors show on the boards ----
let hiddenIns = new Set(); try { hiddenIns = new Set(JSON.parse(localStorage.getItem('hiddenIns') || '[]')); } catch {}
const shownInspectors = () => inspectors.filter(i => !hiddenIns.has(i.id));
function drawInsFilter() {
  $('#insFilter').innerHTML = inspectors.map(i => `<label><input type="checkbox" value="${i.id}"${hiddenIns.has(i.id) ? '' : ' checked'}> ${esc(i.name)}</label>`).join('');
}
$('#insFilter').onchange = e => {
  e.target.checked ? hiddenIns.delete(e.target.value) : hiddenIns.add(e.target.value);
  try { localStorage.setItem('hiddenIns', JSON.stringify([...hiddenIns])); } catch {}
  drawWeek();
};

let weekJobs = [], week2Jobs = [];   // cached jobs for the visible week(s)
const daysFrom = start => [...Array(7)].map((_, i) => { const d = new Date(start + 'T00:00'); d.setDate(d.getDate() + i); return iso(d); });
const weekDays = () => daysFrom(weekStart);
async function fetchWeek(start) {
  const days = daysFrom(start);
  const { data, error } = await sb.from('jobs').select('id,inspector_id,scheduled_start,properties(suburb,clients(name))')
    .gte('scheduled_start', days[0] + 'T00:00').lte('scheduled_start', days[6] + 'T23:59').in('status', ['booked', 'in_progress']);
  if (error) { msg(error.message); return null; }
  return data.map(j => ({ id: j.id, ins: j.inspector_id, day: j.scheduled_start.slice(0,10),
    area: areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || 'No area', agent: j.properties?.clients?.name || 'No agent' }));
}
const nextWeek = () => { const d = new Date(weekStart + 'T00:00'); d.setDate(d.getDate() + 7); return iso(d); };
async function loadWeek() {
  const [jobs, jobs2] = await Promise.all([fetchWeek(weekStart), tab === 'scheduled' ? fetchWeek(nextWeek()) : []]);
  if (!jobs) return;
  weekJobs = jobs; week2Jobs = jobs2 || []; drawWeek(); openDay(); loadAlerts();
}
// Draw any board: table element, week start, jobs, selected inspector/day
function drawBoard(el, start, jobs, selIns, selDay, toIns, toDay) {
  const days = daysFrom(start), cell = {};
  for (const j of jobs) {
    const c = cell[j.ins + '|' + j.day] ??= { total: 0, areas: {} };
    const a = c.areas[j.area] ??= { n: 0, agents: {} };
    c.total++; a.n++; a.agents[j.agent] = (a.agents[j.agent] || 0) + 1;
  }
  const dname = d => new Date(d + 'T00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  el.innerHTML = `<tr><th>Inspector</th>${days.map(d => `<th>${dname(d)}</th>`).join('')}</tr>` +
    shownInspectors().map(i => `<tr><th>${esc(i.name)}</th>${days.map(d => {
      const c = cell[i.id + '|' + d], over = c && c.total > i.daily_capacity;
      const st = selIns === i.id && selDay === d ? 'sel' : toIns === i.id && toDay === d ? 'to' : isAvailable(i, d) ? 'avail' : 'unavail';
      const sel = ` class="${st}" title="${isAvailable(i, d) ? 'Available' : 'Not available'}"`;
      return `<td data-ins="${i.id}" data-day="${d}"${sel}>${c ? `<div class="tot ${over ? 'over' : ''}">${c.total}/${i.daily_capacity}</div>` +
        Object.entries(c.areas).sort((x, y) => y[1].n - x[1].n).map(([a, v]) => `${esc(a)} (${v.n})` +
          Object.entries(v.agents).sort((x, y) => y[1] - x[1]).map(([g, k]) => `<br><i style="color:#555">&nbsp;&nbsp;${esc(g)} (${k})</i>`).join('')).join('<br>') : ''}</td>`;
    }).join('')}</tr>`).join('');
}
function drawWeek() {
  $('#wkLabel').textContent = ` Week of ${weekStart} `;
  $('#boardHead').hidden = tab === 'scheduled';
  const two = tab === 'scheduled';
  $('#week2Wrap').hidden = !two;
  if (two) { $('#wk2Label').textContent = `Following week – ${nextWeek()}`; drawBoard($('#week2'), nextWeek(), week2Jobs, pick.ins, pick.day, to.ins, to.day); }
  drawBoard($('#week'), weekStart, weekJobs, pick.ins, pick.day, tab === 'scheduled' ? to.ins : null, to.day);
  if (tab === 'scheduled') showToPick();
}

// Scheduled page: same board, 1st click = From (blue), later clicks = To (red), click From again = start over
const to = { ins: null, day: null };
let tickAllDay = false;
function showToPick() {
  const ins = inspectors.find(i => i.id === to.ins);
  $('#toPick').textContent = ins ? `To: ${ins.name}, ${new Date(to.day + 'T00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}` : 'To: click another day on the board';
}

const boardClick = e => {
  const td = e.target.closest('td[data-day]'); if (!td) return;
  const isFrom = pick.ins === td.dataset.ins && pick.day === td.dataset.day;
  if (tab === 'scheduled' && pick.ins && !isFrom) { to.ins = td.dataset.ins; to.day = td.dataset.day; return drawWeek(); }
  if (tab === 'scheduled' && isFrom) { pick.ins = pick.day = ''; }   // start over
  else { pick.ins = td.dataset.ins; pick.day = td.dataset.day; tickAllDay = true; }
  to.ins = to.day = null;
  dayTicked.clear(); showTicked(); drawWeek(); openDay();
};
$('#doBook').onclick = async () => {
  const ins = inspectors.find(i => i.id === pick.ins);
  if (!ticked.ready.size) return msg('Tick some on the Ready to book list first');
  if (!ins) return msg('Click an inspector\'s day on the week board first');
  if (!isAvailable(ins, pick.day) && !confirm(`${ins.name} isn't available on ${pick.day}. Book anyway?`)) return;
  const total = onBoard(ins.id, pick.day) + ticked.ready.size;
  if (total > ins.daily_capacity && !confirm(`That makes ${total}/${ins.daily_capacity} for ${ins.name} – over capacity. Book anyway?`)) return;
  bookTicked();
};
// Open day: the selected inspector's jobs for that day
async function openDay() {
  const ins = inspectors.find(i => i.id === pick.ins);
  if (!ins) { $('#dayView').innerHTML = '<h3>Pick a day on the week board</h3><div class="dayBox"></div>'; return; }
  const day = pick.day;
  const { data, error } = await sb.from('jobs').select('id,job_type,status,route_order,notes,properties(address_line,suburb,clients(name))')
    .eq('inspector_id', ins.id).gte('scheduled_start', day + 'T00:00').lte('scheduled_start', day + 'T23:59')
    .in('status', ['booked', 'in_progress']).order('route_order');
  if (error) return msg(error.message);
  const nice = new Date(day + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease', sale: 'Sale', install: 'Install', work_order: 'Work order', upgrade: 'Upgrade' };
  if (tab === 'scheduled') {
    const rows = data.map(j => ({ job_id: j.id, property_id: null, address_line: j.properties?.address_line || '', suburb: j.properties?.suburb || '',
      agency: j.properties?.clients?.name || 'No agent', area: areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || 'No area',
      last_done: null, due_date: null, notes: [label[j.job_type] || j.job_type, j.notes].filter(Boolean).join(' – ') }));
    for (const k of [...ticked.day]) if (!rows.some(r => r.job_id === k)) ticked.day.delete(k);
    if (tickAllDay) { rows.forEach(r => ticked.day.add(r.job_id)); tickAllDay = false; }   // new From day: everything ticked
    $('#dayView').innerHTML = `<h3>From: ${esc(ins.name)} – ${nice} (${data.length}/${ins.daily_capacity})
      <small style="font-weight:normal;color:#555">click an agent or area to show its properties</small></h3>
      <div class="dayBox small"><table id="dayGroups" class="grp heads"></table></div>`;
    renderGrouped(rows, $('#dayGroups'), 'day', 'agency,area');
    showTicked(); return;
  }
  $('#dayView').innerHTML = `<h3>${esc(ins.name)} – ${nice} (${data.length}/${ins.daily_capacity})</h3>
    <div class="dayBox"><table class="grp"><tr><th>${tab === 'scheduled' ? '<input type="checkbox" id="dayAll">' : '#'}</th><th>Address</th><th>Agent</th><th>Area</th><th>Reason</th><th>Status</th><th></th><th>Notes</th></tr>` +
    data.map((j, i) => `<tr${j.id === movedJob ? ' class="moved"' : ''}><td>${tab === 'scheduled' ? `<input type="checkbox" class="dpick" value="${j.id}"${dayTicked.has(j.id) ? ' checked' : ''}>` : i + 1}</td><td>${esc(j.properties?.address_line)}, ${esc(j.properties?.suburb)}</td>
      <td>${esc(j.properties?.clients?.name)}</td><td>${esc(areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || '')}</td>
      <td>${(r => `<span class="why why-${r.toLowerCase().replace(/\s+/g, '-')}">${esc(r)}</span>`)(label[j.job_type] || j.job_type)}</td><td>${esc(j.status)}</td>
      <td>${j.status === 'booked' ? `<button data-unbook="${j.id}" data-type="${j.job_type}">Unbook</button>` : ''}
        <button data-up="${i}" title="Move up" ${i ? '' : 'disabled'}>▲</button><button data-down="${i}" title="Move down" ${i < data.length - 1 ? '' : 'disabled'}>▼</button></td>
      <td>${esc(j.notes)}</td></tr>`).join('') + '</table></div>';
  dayJobIds = data.map(j => j.id);
}
// unbooked jobs keep existing but lose their inspector/day, so they land back in Ready to book
// ---------- Scheduled page actions ----------
const dayTicked = ticked.day;   // job ids ticked in the From day summary
const showTicked = () => $('#schedTicked').textContent = `${dayTicked.size} ticked`;
async function actOnTicked(change, done) {
  const ids = [...dayTicked];
  if (!ids.length) return msg('Tick some jobs in the day list first');
  const { error } = await sb.from('jobs').update(change).in('id', ids);
  if (error) return msg(error.message);
  dayTicked.clear(); showTicked(); msg(done(ids.length)); to.ins = to.day = null;
  Promise.all([loadWeek(), renderReady()]);
}
$('#doMove').onclick = async () => {
  if (!to.ins) return msg('Click a day on the To board first');
  const insTo = inspectors.find(i => i.id === to.ins);
  if (!isAvailable(insTo, to.day) && !confirm(`${insTo.name} isn't available on ${to.day}. Move anyway?`)) return;
  const from = { ins: pick.ins, day: pick.day }, dest = { ...to };
  await actOnTicked({ inspector_id: dest.ins, scheduled_start: `${dest.day}T09:00:00` },
    n => `Moved ${n} to ${inspectors.find(i => i.id === dest.ins).name} on ${dest.day}`);
  await Promise.all([orderDay(dest.ins, dest.day), from.ins ? orderDay(from.ins, from.day) : null]);
  pick.ins = pick.day = ''; to.ins = to.day = null;   // clear blue and red so the next move starts fresh
  drawWeek(); openDay();
};
$('#doUnbook').onclick = () => actOnTicked({ status: 'booked', inspector_id: null, scheduled_start: null, route_order: null }, n => `Unbooked ${n} – back in Ready to book`);
$('#doCancel').onclick = () => {
  if (!dayTicked.size || confirm(`Cancel ${dayTicked.size} jobs? Annual inspections go back to Due.`))
    actOnTicked({ status: 'cancelled' }, n => `Cancelled ${n}`);
};

const unbook = ids => sb.from('jobs').update({ status: 'booked', inspector_id: null, scheduled_start: null, route_order: null }).in('id', [].concat(ids));
let dayJobIds = [], movedJob = null;
$('#dayView').addEventListener('click', async e => {
  const up = e.target.dataset.up, down = e.target.dataset.down;
  if (up == null && down == null) return;
  const i = +(up ?? down), k = up != null ? i - 1 : i + 1;
  [dayJobIds[i], dayJobIds[k]] = [dayJobIds[k], dayJobIds[i]];
  movedJob = dayJobIds[k];
  const rows = [...document.querySelectorAll('#dayView tr:has(td)')];   // swap rows on screen straight away
  if (up != null) rows[i].after(rows[k]); else rows[k].after(rows[i]);
  rows.forEach(r => r.classList.remove('moved')); rows[i].classList.add('moved');
  document.querySelectorAll('#dayView button[data-up],#dayView button[data-down]').forEach(b => b.disabled = true);   // until saved
  await Promise.all(dayJobIds.map((id, n) => sb.from('jobs').update({ route_order: n + 1 }).eq('id', id)));
  openDay();
});
$('#dayView').onclick = async e => {
  const id = e.target.dataset.unbook; if (!id) return;
  e.target.closest('tr').remove(); weekJobs = weekJobs.filter(j => j.id !== id); drawWeek();
  const { error } = await unbook(id);
  if (error) msg(error.message);
  Promise.all([loadWeek(), renderReady()]);
};
$('#unbookDay').onclick = async () => {
  const btns = [...document.querySelectorAll('#dayView [data-unbook]')];
  if (!btns.length) return msg('Nothing booked to unbook on the selected day (completed jobs stay)');
  if (!confirm(`Unbook all ${btns.length} booked jobs on this day? They go back to Ready to book.`)) return;
  const ids = btns.map(b => b.dataset.unbook);
  btns.forEach(b => b.closest('tr').remove()); weekJobs = weekJobs.filter(j => !ids.includes(j.id)); drawWeek();
  const { error } = await unbook(ids);
  msg(error ? error.message : `Unbooked ${btns.length} – back in Ready to book`);
  Promise.all([loadWeek(), renderReady()]);
};
// Weeks run Mon–Sun, but planning rolls over on Saturday: "this week" = the Monday-week containing today + 2 days
const planWeek = offset => { const d = new Date(); d.setDate(d.getDate() + 2); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset); return iso(d); };
document.querySelectorAll('[data-wk]').forEach(b => b.onclick = () => { weekStart = planWeek(+b.dataset.wk); drawWeek(); loadWeek(); });
$('#week').onclick = boardClick; $('#week2').onclick = boardClick;
const shiftWeek = n => { const d = new Date(weekStart + 'T00:00'); d.setDate(d.getDate() + n); weekStart = iso(d); drawWeek(); loadWeek(); };
$('#wkPrev').onclick = () => shiftWeek(-7);
$('#wkNext').onclick = () => shiftWeek(7);

// ---------- Messages (outbox) ----------
async function loadAlerts() {
  const { data, error } = await sb.from('notice_alerts').select('job_id,visit,inspector,address_line,suburb,problem').not('problem', 'is', null).order('visit');
  if (error) return msg(error.message);
  $('#alertBox').innerHTML = !data.length ? '' : `<div style="background:#fff3f3;border:1px solid #e0a0a0;padding:8px;margin:8px 0">
    <b class="bad">⚠ ${data.length} entry notice problem${data.length === 1 ? '' : 's'}</b>
    <table class="grp" style="margin-top:6px"><tr><th>Visit</th><th>Inspector</th><th>Property</th><th>Problem</th></tr>` +
    data.map(a => `<tr class="prow"><td>${date(a.visit)}</td><td>${esc(a.inspector)}</td><td>${esc(a.address_line)}, ${esc(a.suburb)}</td><td>${esc(a.problem)}</td></tr>`).join('') +
    '</table></div>';
  const btn = document.querySelector('aside button[data-tab="messages"]');
  btn.textContent = data.length ? `Messages ⚠ ${data.length}` : 'Messages';
}
const CHANNELS = { email: 'Emails', sms: 'Texts', mail: 'Mail' };
async function loadMessages() {
  loadAlerts();
  let q = sb.from('messages').select('id,kind,channel,to_name,to_address,subject,body,for_date,send_after,status,error,properties(address_line,suburb)')
    .order('for_date', { nullsFirst: false }).order('send_after').limit(1000);
  if ($('#msgStatus').value) q = q.eq('status', $('#msgStatus').value);
  const { data, error } = await q;
  if (error) return msg(error.message);
  const kind = { entry_notice: 'Entry notice', entry_notice_changed: 'Entry notice – date changed', reminder: 'Reminder' };
  const del = $('#msgStatus').value === 'cancelled';
  document.querySelectorAll('#msgSections [data-act="del"]').forEach(b => { if (!b.disabled) b.textContent = del ? 'Restore' : 'Delete'; });
  for (const ch in CHANNELS) {
    const rows = data.filter(m => m.channel === ch);
    $('#msgH-' + ch).textContent = `${{ email: '✉', sms: '💬', mail: '📮' }[ch]} ${CHANNELS[ch]} (${rows.length})`;
    $('#msgList-' + ch).innerHTML = !rows.length ? '<tr><td style="color:#777">None</td></tr>' :
      `<tr><th><input type="checkbox" class="mall"></th><th>${ch === 'mail' ? 'Status' : 'Send (Qld time)'}</th><th>To / subject</th><th>Message</th></tr>` +
      rows.map((m, i) => (m.for_date !== rows[i - 1]?.for_date ? `<tr class="g1"><td></td><td colspan="3">Inspection ${m.for_date ? new Date(m.for_date + 'T00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }) : '– no date'} — ${rows.filter(x => x.for_date === m.for_date).length}</td></tr>` : '') +
        `<tr class="prow"><td><input type="checkbox" class="mpick" value="${m.id}"></td>
        <td>${ch === 'mail' ? (m.status === 'sent' ? 'Posted' : 'Print & post now') : new Date(m.send_after).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
        <td style="white-space:normal;width:22%"><b>${esc(m.to_name)}</b> <small>${esc(m.to_address || '— none')}</small><br>
          ${esc(m.properties?.address_line)}, ${esc(m.properties?.suburb)} – ${kind[m.kind] || esc(m.kind)}${m.error ? `<br><small class="bad">${esc(m.error)}</small>` : ''}</td>
        <td style="white-space:pre-wrap;font-size:13px">${esc(m.body)}</td></tr>`).join('');
  }
}
$('#msgStatus').onchange = loadMessages;
$('#msgSections').onchange = e => {
  if (e.target.classList.contains('mall')) e.target.closest('table').querySelectorAll('.mpick').forEach(c => c.checked = e.target.checked);
};
// Progress shows as red text to the right of the bar's buttons: "Sending…" → "Sent" for 3 seconds → cleared
const barNote = btn => { const bar = btn.parentElement; return bar.querySelector('.barNote') || bar.appendChild(Object.assign(document.createElement('span'), { className: 'barNote' })); };
const note = (btn, t, keep) => { const n = barNote(btn); n.textContent = t; clearTimeout(n.timer); if (!keep) n.timer = setTimeout(() => n.textContent = '', 3000); };
async function busy(btn, doing, done, fn) {
  const btns = btn.parentElement.querySelectorAll('button'); btns.forEach(b => b.dataset.was = b.disabled), btns.forEach(b => b.disabled = true);
  note(btn, doing, true);
  let ok = false;
  try { ok = await fn(); } catch (e) { msg(e.message); }
  await loadMessages();
  btns.forEach(b => b.disabled = b.dataset.was === 'true');
  note(btn, ok ? done : 'Failed – see the message at the top');
}
$('#msgSections').onclick = e => {
  const btn = e.target.closest('button[data-act]'); if (!btn || btn.disabled) return;
  const ch = btn.dataset.ch, act = btn.dataset.act;
  const ids = [...document.querySelectorAll(`#msgList-${ch} .mpick:checked`)].map(c => c.value);
  if (!ids.length) return note(btn, 'Tick some first');
  if (act === 'print') return open('letter.html?ids=' + ids.join(','), '_blank');
  if (act === 'posted') return busy(btn, 'Saving…', 'Done', async () => {
    const { error } = await sb.from('messages').update({ status: 'sent', sent_at: new Date().toISOString() }).in('id', ids);
    if (error) msg(error.message); return !error;
  });
  if (act === 'del') {
    const restore = btn.textContent === 'Restore';
    if (!restore && !confirm(`Delete ${ids.length} ${CHANNELS[ch].toLowerCase()}? (They can be restored from the Deleted view.)`)) return;
    return busy(btn, restore ? 'Restoring…' : 'Deleting…', restore ? 'Restored' : 'Deleted', async () => {
      const { error } = await sb.from('messages').update({ status: restore ? 'queued' : 'cancelled', error: null }).in('id', ids);
      if (error) msg(error.message); return !error;
    });
  }
  if (act === 'send') return busy(btn, 'Sending…', 'Sent', async () => {
    const { error } = await sb.from('messages').update({ send_after: new Date().toISOString(), status: 'queued', error: null }).in('id', ids);
    if (error) { msg(error.message); return false; }
    const { data, error: fnErr } = await sb.functions.invoke('Send-messages');   // function slug as created in Supabase (case-sensitive)
    if (fnErr) {
      let why = fnErr.message;
      if (fnErr.context?.text) { try { const t = await fnErr.context.text(); why = (JSON.parse(t).error || t) + ` (status ${fnErr.context.status})`; } catch {} }
      msg('Sending failed: ' + why); return false;
    }
    if (data.failed) msg(`${data.failed} failed – the reason is shown on the message (Problems view)`);
    else msg('');
    return !data.failed;
  });
};

// ---------- Templates ----------
const PLACEHOLDERS = ['Tenant greeting', 'Tenant names', 'Address', 'Suburb', 'Postcode', 'Visit date', 'Old visit date', 'Inspector', 'Company'];
let templates = [], tplField = null;
const sampleVars = () => ({ 'Tenant greeting': 'Sam & Alex', 'Tenant names': 'Sam Smith & Alex Jones', Address: '8 Aaron Street', Suburb: 'COOMERA',
  Postcode: '4209', 'Visit date': 'Tuesday 8 December 2026', 'Old visit date': 'Friday 4 December 2026', Inspector: 'Liam',
  Company: ($('#who').textContent.split(' · ')[0] || 'Your company') });
const fill = (t, v) => Object.entries(v).reduce((s, [k, x]) => s.split('{' + k + '}').join(x), t || '');
async function loadTemplates() {
  const docs = tab === 'docs';
  $('#tplTitle').textContent = docs ? 'Document wording' : 'Message templates';
  let q = sb.from('templates').select('*').order('name');
  q = docs ? q.eq('channel', 'doc') : q.neq('channel', 'doc');
  const { data, error } = await q;
  if (error) return msg(error.message);
  templates = data;
  const cur = $('#tplPick').value;
  $('#tplPick').innerHTML = data.map(t => `<option value="${t.id}">${t.channel === 'sms' ? '💬 ' : t.channel === 'doc' ? '📄 ' : '✉ '}${esc(t.name)}</option>`).join('');
  if (cur && data.some(t => t.id === cur)) $('#tplPick').value = cur;
  $('#tplChips').innerHTML = PLACEHOLDERS.map(p => `<button type="button" data-ph="${p}">{${p}}</button>`).join('');
  showTemplate();
}
function showTemplate() {
  const t = templates.find(x => x.id === $('#tplPick').value); if (!t) return;
  $('#tplSubject').value = t.subject || ''; $('#tplBody').value = t.body || ''; $('#tplInfo').textContent = '';
  const sms = t.channel === 'sms', doc = t.channel === 'doc';
  $('#tplSubject').closest('label').hidden = sms || doc; $('#tplBody').rows = sms ? 5 : doc ? 10 : 18;
  previewTemplate();
}
function previewTemplate() {
  const v = sampleVars();
  $('#tplPrevSubject').textContent = fill($('#tplSubject').value, v);
  $('#tplPrevBody').textContent = fill($('#tplBody').value, v);
  const t = templates.find(x => x.id === $('#tplPick').value);
  if (t?.channel === 'doc') $('#tplPrevSubject').textContent = '';
  if (t?.channel === 'sms') {   // 1 text = 160 characters (70 if it contains emoji etc.)
    const len = $('#tplPrevBody').textContent.length, per = /[^\x00-\x7F’–]/.test($('#tplPrevBody').textContent) ? 70 : 160;
    $('#tplPrevSubject').textContent = `Text message · ${len} characters · ${Math.ceil(len / per) || 1} text${len > per ? 's' : ''} (with example details)`;
  }
}
$('#tplPick').onchange = showTemplate;
['#tplSubject', '#tplBody'].forEach(id => { $(id).oninput = () => { previewTemplate(); $('#tplInfo').textContent = 'Unsaved changes'; }; $(id).onfocus = () => tplField = $(id); });
$('#tplChips').onclick = e => {
  const ph = e.target.dataset.ph; if (!ph) return;
  const f = tplField || $('#tplBody'), at = f.selectionStart ?? f.value.length;
  f.value = f.value.slice(0, at) + '{' + ph + '}' + f.value.slice(f.selectionEnd ?? at);
  f.focus(); f.selectionStart = f.selectionEnd = at + ph.length + 2; f.oninput();
};
$('#tplSave').onclick = async () => {
  const id = $('#tplPick').value;
  const { error } = await sb.from('templates').update({ subject: $('#tplSubject').value, body: $('#tplBody').value, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return msg(error.message);
  const t = templates.find(x => x.id === id); t.subject = $('#tplSubject').value; t.body = $('#tplBody').value;
  $('#tplInfo').textContent = 'Saved – new messages will use this';
};

// ---------- Company settings ----------
const PLATFORM_DOMAIN = 'yourdomain.com.au';   // change when the real sending domain is set up
async function loadCompany() {
  const { data, error } = await sb.from('companies').select('name,sender_name,sender_code,reply_to_email,phone,abn,qbcc_licence').eq('id', companyId).single();
  if (error) return msg(error.message);
  const f = $('#coForm'); for (const k in data) if (f[k]) f[k].value = data[k] ?? '';
  coPreview();
}
function coPreview() {
  const f = $('#coForm');
  $('#coPreview').innerHTML = `Tenants will see emails from:<br><b>${esc(f.sender_name.value || f.name.value)}</b> &lt;${esc(f.sender_code.value || 'code')}@${PLATFORM_DOMAIN}&gt;<br>
    When they reply, it goes to: <b>${esc(f.reply_to_email.value || '— not set —')}</b>`;
}
$('#coForm').oninput = coPreview;
$('#coForm').onsubmit = async e => {
  e.preventDefault();
  const row = {}; for (const [k, v] of new FormData(e.target)) row[k] = v.trim() || null;
  const { error } = await sb.from('companies').update(row).eq('id', companyId);
  msg(error ? error.message : 'Settings saved');
};

// ---------- Prices & lists ----------
const PX = [['action', 'Actions (priced)', true], ['replace_reason', 'Replacement reasons (priced – used instead of the Replaced price)', true], ['quote', 'Quotes (priced)', true],
  ['extra', 'Other charges (priced)', true], ['location', 'Locations', false], ['device_type', 'Alarm / device types', false]];
let pxRows = [];
async function loadPrices() {
  const { data, error } = await sb.from('price_items').select('*').order('sort').order('name');
  if (error) return msg(error.message);
  pxRows = data; drawPrices(); $('#pxInfo').textContent = '';
}
function drawPrices() {
  $('#pxLists').innerHTML = PX.map(([k, title, priced]) => `<div><h3 style="margin-top:0">${title}</h3><table class="grp">
    <tr><th>Name</th>${priced ? '<th>Price inc GST</th><th>GST</th><th>Ex GST</th>' : ''}<th>Show</th></tr>` +
    pxRows.map((r, i) => r.kind !== k ? '' : `<tr class="prow"><td><input type="text" data-px="${i}" data-f="name" value="${esc(r.name)}"></td>
      ${priced ? `<td>$<input type="number" step="0.01" min="0" data-px="${i}" data-f="price" value="${r.price ?? 0}"></td>
        <td class="gst" data-gst="${i}">${money(Number(r.price || 0) / 11)}</td><td class="gst" data-ex="${i}">${money(Number(r.price || 0) / 1.1)}</td>` : ''}
      <td><input type="checkbox" data-px="${i}" data-f="active"${r.active ? ' checked' : ''}></td></tr>`).join('') +
    `</table><button type="button" data-pxadd="${k}">+ Add</button></div>`).join('');
}
$('#pxLists').oninput = e => {
  const r = pxRows[+e.target.dataset.px]; if (!r) return;
  const f = e.target.dataset.f; r[f] = f === 'active' ? e.target.checked : f === 'price' ? Number(e.target.value) : e.target.value;
  r.dirty = true; $('#pxInfo').textContent = 'Unsaved changes';
  if (f === 'price') {   // prices include GST: GST = 1/11 of the price
    $(`[data-gst="${e.target.dataset.px}"]`).textContent = money(r.price / 11);
    $(`[data-ex="${e.target.dataset.px}"]`).textContent = money(r.price / 1.1);
  }
};
$('#pxLists').onclick = e => {
  const k = e.target.dataset.pxadd; if (!k) return;
  pxRows.push({ kind: k, name: '', price: 0, active: true, sort: 99, company_id: companyId, dirty: true }); drawPrices();
  [...document.querySelectorAll('#pxLists input[data-f="name"]')].pop()?.focus();
};
$('#pxSave').onclick = async () => {
  const rows = pxRows.filter(r => r.dirty && r.name.trim()).map(({ dirty, ...r }) => ({ ...r, name: r.name.trim(), company_id: companyId }));
  if (!rows.length) return msg('Nothing to save');
  const withId = rows.filter(r => r.id), fresh = rows.filter(r => !r.id).map(({ id, ...r }) => r);
  const res = await Promise.all([withId.length ? sb.from('price_items').upsert(withId) : {}, fresh.length ? sb.from('price_items').insert(fresh) : {}]);
  const err = res.find(r => r.error)?.error;
  msg(err ? err.message : `Saved ${rows.length}`); if (!err) loadPrices();
};

// ---------- Completed ----------
async function loadCompleted() {
  const f = $('#doneFilter');
  if (!f.from.value) { const d = new Date(); d.setDate(d.getDate() - 7); f.from.value = iso(d); f.to.value = iso(new Date()); }
  let q = sb.from('completed_summary').select('*').gte('done_at', f.from.value + 'T00:00').lte('done_at', f.to.value + 'T23:59')
    .order('done_at', { ascending: false }).limit(1000);
  const t = f.q.value.trim();
  if (t) q = q.or(`address_line.ilike.%${t}%,suburb.ilike.%${t}%,agency.ilike.%${t}%`);
  const { data, error } = await q;
  if (error) return msg(error.message);
  const done = data.filter(r => r.status === 'completed');
  const groups = [
    ['Serviced – no issues', done.filter(r => !r.has_invoice && !r.has_quote), false],
    ['Invoices – extra work done', done.filter(r => r.has_invoice), true],
    ['Quotes', done.filter(r => r.has_quote), true],
    ['No access', data.filter(r => r.status === 'no_access'), true]];
  const when = d => new Date(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const cleats = r => r.blind_cleats === 'Installed' ? `Blind cleats installed ×${r.blind_cleats_needed || '?'}` : r.blind_cleats === 'Needed' ? `Blind cleats needed ×${r.blind_cleats_needed || '?'}` : '';
  const btn = r => `<button type="button" class="appr ${r.approved_at ? 'done' : ''}" data-appr="${r.id}">${r.approved_at ? '✓ Approved' : 'Approve'}</button>`;
  $('#doneLists').innerHTML = groups.map(([title, rows, open], gi) => `<details class="doneGrp" open>
    <summary><b>${title}</b> — ${rows.length} <small style="color:#555">(${rows.filter(r => r.approved_at).length} approved)</small>
      ${rows.some(r => !r.approved_at) ? `<button type="button" class="appr" data-apprall="${gi}">Approve all</button>` : ''}</summary>
    ${rows.length ? `<table class="grp"><tr><th></th><th>Date</th><th>Property</th><th>Agent</th><th>Inspector</th><th>Result</th><th>Summary</th></tr>` +
      rows.map(r => `<tr class="prow"><td>${btn(r)}</td><td>${when(r.done_at)}</td><td>${esc(r.address_line)}, ${esc(r.suburb)}</td><td>${esc(r.agency)}</td><td>${esc(r.inspector)}</td>
        <td>${r.status === 'no_access' ? '<span class="bad">No access</span>' : r.compliant ? '<span class="good">Compliant</span>' : '<span class="bad">Non-compliant</span>'}
          ${r.certificate ? `<br><a href="cert.html?job=${r.id}" target="_blank"><small>${esc(r.certificate)} – preview</small></a>` : ''}</td>
        <td style="white-space:normal">${[r.actions, cleats(r), r.quotes ? '<b>Quote:</b> ' + esc(r.quotes) : '',
          r.safety_switch && r.safety_switch !== 'Tested OK' ? 'Safety switch: ' + esc(r.safety_switch) + (r.safety_switch_notes ? ' – ' + esc(r.safety_switch_notes) : '') : '',
          r.comment ? '<i>' + esc(r.comment) + '</i>' : ''].filter(Boolean).map(x => x.startsWith('<') ? x : esc(x)).join('<br>')}</td></tr>`).join('') + '</table>'
      : '<p style="color:#555">None in this period.</p>'}</details>`).join('');
}
$('#doneFilter').onsubmit = e => { e.preventDefault(); loadCompleted(); };
// Approve: blue → green, saved in the background
let doneGroups = [];
async function setApproved(ids, on) {
  ids.forEach(id => document.querySelectorAll(`[data-appr="${id}"]`).forEach(b => { b.classList.toggle('done', on); b.textContent = on ? '✓ Approved' : 'Approve'; }));
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from('jobs').update(on ? { approved_at: new Date().toISOString(), approved_by: user?.id } : { approved_at: null, approved_by: null }).in('id', ids);
  if (error) { msg(error.message); return loadCompleted(); }
  loadCompleted();
}
$('#doneLists').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  e.preventDefault();
  if (b.dataset.appr) {
    const on = !b.classList.contains('done');
    if (!on && !confirm('Undo approval for this job?')) return;
    return setApproved([b.dataset.appr], on);
  }
  if (b.dataset.apprall) {
    const ids = [...b.closest('details').querySelectorAll('[data-appr]:not(.done)')].map(x => x.dataset.appr);
    if (ids.length && confirm(`Approve all ${ids.length} jobs in this section?`)) setApproved(ids, true);
  }
};

// ---------- Inspector availability (Admin → Inspectors) ----------
let availIns = [];
async function loadAvail() {
  const [{ data, error }] = await Promise.all([sb.from('inspectors').select('id,name').eq('active', true).order('name'), loadOverrides()]);
  if (error) return msg(error.message);
  availIns = data;
  const dn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const t0 = new Date(); t0.setHours(0, 0, 0, 0); t0.setDate(t0.getDate() - ((t0.getDay() + 6) % 7));
  const dt = k => { const d = new Date(t0); d.setDate(d.getDate() + k); return d; };
  const short = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  $('#availNow').textContent = 'Weekdays are available and weekends are not, unless you change a day here.';
  $('#availGrid').innerHTML = `<tr><th></th>${[0, 1, 2, 3].map(w => `<th colspan="7">${short(dt(w * 7))} – ${short(dt(w * 7 + 6))}</th>`).join('')}</tr>
    <tr><th>Inspector</th>${[...Array(28)].map((_, k) => `<th>${dn[k % 7]}<br><small style="font-weight:normal">${dt(k).getDate()}</small></th>`).join('')}</tr>` +
    data.map(i => `<tr><th>${esc(i.name)}</th>${[...Array(28)].map((_, k) => { const d = iso(dt(k)), on = isAvailable(i, d);
      return `<td class="${on ? 'on' : 'off'}" data-ins="${i.id}" data-day="${d}">${on ? '✓' : '✗'}</td>`; }).join('')}</tr>`).join('');
}
$('#availGrid').onclick = async e => {
  const td = e.target.closest('td[data-day]'); if (!td) return;
  const ins = availIns.find(i => i.id === td.dataset.ins), d = td.dataset.day, now = !isAvailable(ins, d);
  td.className = now ? 'on' : 'off'; td.textContent = now ? '✓' : '✗';   // show straight away
  const key = ins.id + '|' + d;
  const { error } = now === isWeekday(d)      // back to normal → remove the change; otherwise save it
    ? (delete dayOverrides[key], await sb.from('inspector_days').delete().eq('inspector_id', ins.id).eq('day', d))
    : (dayOverrides[key] = now, await sb.from('inspector_days').upsert({ company_id: companyId, inspector_id: ins.id, day: d, available: now }));
  if (error) { msg(error.message); loadAvail(); }
};

// ---------- Home ----------
async function loadHome() {
  const today = iso(new Date()), in14 = addDays(14), in30 = addDays(30), ago30 = addDays(-30);
  const cnt = q => q.then(r => r.count ?? 0);
  const head = t => sb.from(t).select('*', { count: 'exact', head: true });
  const [due, overdue, breakdowns, unassigned, toApprove, queued, alerts, leases, todayJobs, ins] = await Promise.all([
    cnt(head('schedule_queue').lte('due_date', in14)),
    cnt(head('schedule_queue').lt('due_date', today).eq('reason', 'Annual')),
    cnt(head('schedule_queue').eq('reason', 'Breakdown')),
    cnt(head('jobs').is('inspector_id', null).in('status', ['booked'])),
    cnt(head('completed_summary').is('approved_at', null).gte('done_at', ago30 + 'T00:00')),
    cnt(head('messages').eq('status', 'queued')),
    cnt(head('notice_alerts').not('problem', 'is', null)),
    cnt(head('tenancies').gte('lease_end', today).lte('lease_end', in30).is('vacate_date', null)),
    sb.from('jobs').select('inspector_id,status').gte('scheduled_start', today + 'T00:00').lte('scheduled_start', today + 'T23:59')
      .in('status', ['booked', 'in_progress', 'completed', 'no_access']).then(r => r.data || []),
    sb.from('inspectors').select('id,name,daily_capacity').eq('active', true).order('name').then(r => r.data || [])]);
  const ready = unassigned + staged.size;
  drawHomeCharts(ins);
  const h = new Date().getHours();
  $('#homeHello').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}`;
  const card = (tabName, n, label, sub = '', warn = false) =>
    `<a href="#" data-go="${tabName}"><div class="n ${warn && n ? 'bad' : ''}">${n}</div><div class="l">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</a>`;
  $('#homeCards').innerHTML = [
    card('due', due, 'Due in the next 2 weeks', `${overdue ? `<span class="bad">${overdue} overdue</span> · ` : ''}${breakdowns} breakdown${breakdowns === 1 ? '' : 's'}`),
    card('book', ready, 'Ready to book', 'waiting for an inspector and day'),
    card('completed', toApprove, 'Waiting for approval', 'completed in the last 30 days'),
    card('messages', queued, 'Messages queued', alerts ? `<span class="bad">⚠ ${alerts} entry notice problem${alerts === 1 ? '' : 's'}</span>` : 'no problems'),
    card('tenants', leases, 'Leases ending soon', 'in the next 30 days')].join('');
  const rows = ins.map(i => {
    const js = todayJobs.filter(j => j.inspector_id === i.id); if (!js.length) return '';
    const done = js.filter(j => ['completed', 'no_access'].includes(j.status)).length;
    return `<p><b style="display:inline-block;width:110px">${esc(i.name)}</b><span class="prog"><i style="width:${Math.round(done / js.length * 100)}%"></i></span>${done} of ${js.length} done</p>`;
  }).join('');
  $('#homeToday').innerHTML = rows || '<p style="color:#555">No jobs booked for today.</p>';
}
// Small SVG bar charts – no library needed
const C = { due: '#f2994a', booked: '#1f6feb', done: '#1e8e3e', noacc: '#e0b400', cap: '#52606d', grid: '#e4e7eb', text: '#52606d' };
function barChart(el, weeks, series, line) {
  const W = 520, H = 200, L = 34, B = 28, T = 8, R = 6, cw = (W - L - R) / weeks.length;
  const max = Math.max(1, line?.value || 0, ...weeks.map((_, i) => series.reduce((m, s) => Math.max(m, s.stack ? series.filter(x => x.stack).reduce((t, x) => t + x.values[i], 0) : s.values[i]), 0)));
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw), top = step * 4;   // round axis steps
  const y = v => T + (H - T - B) * (1 - v / top);
  const groups = [...new Set(series.map(s => s.stack ? 'stack' : s.key))], bw = Math.min(26, (cw - 8) / groups.length);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="chart">`;
  for (let k = 0; k <= 4; k++) { const v = top * k / 4; svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${L - 4}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="${C.text}">${Math.round(v)}</text>`; }
  weeks.forEach((w, i) => {
    const x0 = L + i * cw + (cw - bw * groups.length) / 2;
    let stackY = 0;
    groups.forEach((g, gi) => {
      series.filter(s => (s.stack ? 'stack' : s.key) === g).forEach(s => {
        const v = s.values[i], base = s.stack ? stackY : 0, h = y(base) - y(base + v);
        if (v) svg += `<rect x="${x0 + gi * bw + 1}" y="${y(base + v)}" width="${bw - 2}" height="${h}" fill="${s.color}" rx="2"><title>${s.label}: ${v}</title></rect>`;
        if (s.stack) stackY += v;
      });
    });
    svg += `<text x="${L + i * cw + cw / 2}" y="${H - 10}" font-size="10" text-anchor="middle" fill="${C.text}">${w.label}</text>`;
  });
  if (line) svg += `<line x1="${L}" x2="${W - R}" y1="${y(line.value)}" y2="${y(line.value)}" stroke="${C.cap}" stroke-width="2" stroke-dasharray="5 4"><title>${line.label}: ${line.value}</title></line>`;
  svg += '</svg>';
  el.innerHTML = svg + `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}${line ? `<span><i style="background:${C.cap};height:2px"></i>${line.label} (${line.value}/wk)</span>` : ''}</div>`;
}
async function drawHomeCharts(ins) {
  const monday = n => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n * 7); return iso(d); };
  const lab = d => new Date(d + 'T00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const [{ data: due }, { data: jobs }] = await Promise.all([sb.from('home_due_weekly').select('*'), sb.from('home_jobs_weekly').select('*')]);
  const find = (rows, wk, k) => Number((rows || []).find(r => r.wk === wk)?.[k] || 0);
  const ahead = [...Array(8)].map((_, i) => ({ wk: monday(i), label: i === 0 ? 'This wk' : lab(monday(i)) }));
  barChart($('#chartAhead'), ahead, [
    { key: 'due', label: 'Due (overdue in this week)', color: C.due, values: ahead.map(w => find(due, w.wk, 'due')) },
    { key: 'booked', label: 'Booked', color: C.booked, values: ahead.map(w => find(jobs, w.wk, 'booked')) }],
    { label: 'Team capacity', value: (ins || []).reduce((t, i) => t + (i.daily_capacity || 0), 0) * 5 });
  const past = [...Array(12)].map((_, i) => ({ wk: monday(i - 11), label: lab(monday(i - 11)) }));
  barChart($('#chartDone'), past, [
    { key: 'done', label: 'Completed', color: C.done, stack: true, values: past.map(w => find(jobs, w.wk, 'completed')) },
    { key: 'noacc', label: 'No access', color: C.noacc, stack: true, values: past.map(w => find(jobs, w.wk, 'no_access')) }]);
}
$('#homeCards').onclick = e => { const a = e.target.closest('[data-go]'); if (!a) return; e.preventDefault(); document.querySelector(`aside button[data-tab="${a.dataset.go}"]`).click(); };

// Events
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), act = e.submitter.value;
  const creds = { email: f.get('email'), password: f.get('password') };
  const { error } = act === 'up'
    ? await sb.auth.signUp({ ...creds, options: { emailRedirectTo: location.origin + location.pathname } })
    : await sb.auth.signInWithPassword(creds);
  if (error) return msg(error.message);
  msg(act === 'up' ? 'Check your email to confirm, then sign in.' : '');
  start();
});

$('#setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await sb.rpc('create_company', { company_name: f.get('company'), your_name: f.get('name') });
  if (error) return msg(error.message);
  start();
});

document.querySelectorAll('form[data-table]').forEach(form => form.addEventListener('submit', async e => {
  e.preventDefault();
  const row = { company_id: companyId };
  for (const [k, v] of new FormData(form)) if (v !== '') row[k] = v;
  if (form.querySelector('.propSearch') && !row.property_id) return msg('Pick an address from the list');
  const { error } = await sb.from(form.dataset.table).insert(row);
  if (error) return msg(error.message);
  msg(''); form.reset(); loadList(); if (form.dataset.table === 'clients') loadClientPick();
}));

$('#list').addEventListener('click', e => { const tr = e.target.closest('tr.click'); if (tr && e.target.tagName !== 'SELECT') openProperty(tr.dataset.id); });
$('#list').addEventListener('change', async e => {
  const id = e.target.dataset.job; if (!id) return;
  const { error } = await sb.from('jobs').update({ status: e.target.value }).eq('id', id);
  msg(error ? error.message : '');
});
let timer;
$('#search').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { term = e.target.value.trim(); page = 0; loadList(); }, 300); });
$('#prev').onclick = () => { page--; loadList(); };
$('#next').onclick = () => { page++; loadList(); };
$('#back').onclick = () => { $('#detail').classList.add('hidden'); $('#listArea').classList.remove('hidden'); document.querySelectorAll('.tab form').forEach(f => f.classList.remove('hidden')); loadList(); };
// Admin group in the sidebar opens/closes; stays open while one of its pages is showing
$('#adminToggle').onclick = () => { const m = $('#adminMenu'); m.hidden = !m.hidden; $('#adminToggle').textContent = m.hidden ? 'Admin ▸' : 'Admin ▾'; };
document.querySelectorAll('aside button[data-tab]').forEach(b => b.onclick = () => {
  tab = b.dataset.tab; page = 0; term = ''; $('#search').value = '';
  document.querySelectorAll('aside button').forEach(x => x.classList.toggle('on', x === b));
  if (b.closest('#adminMenu')) { $('#adminMenu').hidden = false; $('#adminToggle').textContent = 'Admin ▾'; }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
  $('#detail').classList.add('hidden');
  $('#weekArea').classList.toggle('hidden', !['book', 'scheduled'].includes(tab));
  $('#toArea').classList.toggle('hidden', tab !== 'scheduled');
  if (tab === 'scheduled') { $('#schedSide').append($('#dayView'), $('#toArea')); }
  else { $('#week').after($('#dayView')); }
  if (tab === 'inspectors') loadAvail();
  if (tab === 'home') { $('#listArea').classList.add('hidden'); return loadHome(); }
  if (tab === 'completed') { $('#listArea').classList.add('hidden'); return loadCompleted(); }
  if (tab === 'prices') { $('#listArea').classList.add('hidden'); return loadPrices(); }
  if (tab === 'settings') { $('#listArea').classList.add('hidden'); return loadCompany(); }
  if (tab === 'docs') { $('#tab-templates').classList.remove('hidden'); $('#listArea').classList.add('hidden'); return loadTemplates(); }
  if (tab === 'templates') { $('#listArea').classList.add('hidden'); return loadTemplates(); }
  if (tab === 'documents') { $('#listArea').classList.add('hidden'); docPage = 0; return loadDocs(); }
  if (tab === 'messages') { $('#listArea').classList.add('hidden'); return loadMessages(); }
  if (['due', 'book', 'scheduled'].includes(tab)) { $('#listArea').classList.add('hidden'); return openSchedule(); }
  $('#back').onclick();
});
// Keep several open windows in step: reload the current table when you come back to a window
const reloaders = { home: () => loadHome(), completed: () => loadCompleted(), documents: () => loadDocs(), messages: () => loadMessages(),
  due: () => openSchedule(), book: () => openSchedule(), scheduled: () => openSchedule(),
  clients: () => loadList(), properties: () => loadList(), tenants: () => loadList(), inspectors: () => loadList() };
let leftAt = 0;
const refreshTab = () => {
  if (!companyId || !$('#detail').classList.contains('hidden')) return;     // not signed in / property open
  if (document.activeElement?.matches('input:not([type=checkbox]),textarea,select')) return;   // or half-typed input
  reloaders[tab]?.();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) leftAt = Date.now(); else if (Date.now() - leftAt > 10000) refreshTab(); });
window.addEventListener('blur', () => leftAt = Date.now());
window.addEventListener('focus', () => { if (leftAt && Date.now() - leftAt > 10000) refreshTab(); leftAt = 0; });
// Due -> Book list lives in this browser: follow changes made in another window straight away
window.addEventListener('storage', e => {
  if (e.key !== 'staged2') return;
  staged.clear(); try { for (const [k, v] of JSON.parse(e.newValue || '[]')) staged.set(k, v); } catch {}
  if (['due', 'book', 'scheduled'].includes(tab)) openSchedule();
});

// Documents: certificates + invoices together, newest first, 10 per page
const DOCS = 10; let docPage = 0;
async function loadDocs() {
  const type = $('#docType').value, t = $('#docSearch').value.trim(), n = (docPage + 1) * DOCS;
  const cq = sb.from('certificates').select('job_id,number,compliant,issued_at,jobs(properties(address_line,suburb))', { count: 'exact' }).order('issued_at', { ascending: false }).limit(n);
  const iq = sb.from('invoices').select('number,amount_ex_gst,gst,status,created_at,clients(name)', { count: 'exact' }).order('created_at', { ascending: false }).limit(n);
  if (t) { cq.ilike('number', `%${t}%`); iq.ilike('number', `%${t}%`); }
  const none = { data: [], count: 0 };
  const [c, i] = await Promise.all([type === 'inv' ? none : cq, type === 'cert' ? none : iq]);
  if (c.error || i.error) return msg((c.error || i.error).message);
  const rows = [...c.data.map(r => ({ d: r.issued_at, type: 'Certificate', num: r.number, who: [r.jobs?.properties?.address_line, r.jobs?.properties?.suburb].filter(Boolean).join(', '),
      info: r.compliant ? '<span class=good>Compliant</span>' : '<span class=bad>Non-compliant</span>', link: `cert.html?job=${r.job_id}` })),
    ...i.data.map(r => ({ d: r.created_at, type: 'Invoice', num: r.number, who: r.clients?.name || '',
      info: `${money(Number(r.amount_ex_gst) + Number(r.gst || 0))} inc GST · ${esc(r.status)}` }))]
    .sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(docPage * DOCS, n);
  const total = (c.count || 0) + (i.count || 0), pages = Math.max(1, Math.ceil(total / DOCS));
  $('#docInfo').textContent = ` Page ${docPage + 1} of ${pages} (${total}) `;
  $('#docPrev').disabled = docPage === 0; $('#docNext').disabled = docPage + 1 >= pages;
  $('#docList').innerHTML = '<tr><th>Date</th><th>Type</th><th>Number</th><th>Property / client</th><th>Details</th><th></th></tr>' +
    rows.map(r => `<tr><td>${date(r.d)}</td><td>${r.type}</td><td>${esc(r.num)}</td><td>${esc(r.who)}</td><td>${r.info}</td>
      <td>${r.link ? `<a href="${r.link}" target="_blank">Open</a>` : ''}</td></tr>`).join('');
}
$('#docType').onchange = () => { docPage = 0; loadDocs(); };
let docTimer; $('#docSearch').oninput = () => { clearTimeout(docTimer); docTimer = setTimeout(() => { docPage = 0; loadDocs(); }, 300); };
$('#docPrev').onclick = () => { docPage--; loadDocs(); };
$('#docNext').onclick = () => { docPage++; loadDocs(); };

$('#logout').onclick = async () => { await sb.auth.signOut(); show('login'); };

start();

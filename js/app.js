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
const money = v => v == null ? '' : '$' + Number(v).toFixed(2);

// What each tab lists, what it searches, how it sorts
const views = {
  clients: { table:'clients', select:'id,name,type,billing_email,phone', search:'name', order:'name', asc:true,
    cols:[['Name','name'],['Type','type'],['Billing email','billing_email'],['Phone','phone']] },
  properties: { table:'properties', select:'id,address_line,suburb,postcode,next_due,tenant_name,clients(name)', search:'address_line', order:'address_line', asc:true, click:true,
    cols:[['Address','address_line'],['Suburb','suburb'],['Agency','clients.name'],['Tenant','tenant_name'],['Next due','next_due',date]] },
  tenants: { table:'tenancies', select:'id,tenant_names,mobile,email,lease_start,lease_end,vacate_date,property_id,properties!inner(address_line,suburb)', search:'tenant_names', order:'lease_end', asc:false, click:'property_id',
    cols:[['Address','properties.address_line'],['Suburb','properties.suburb'],['Tenants','tenant_names'],['Mobile','mobile'],['Email','email'],['Lease start','lease_start',date],['Lease end','lease_end',leaseEnd,'html'],['Vacate','vacate_date',date]] },
  inspectors: { table:'inspectors', select:'name,phone,base_suburb,daily_capacity,active', search:'name', order:'name', asc:true,
    cols:[['Name','name'],['Phone','phone'],['Home suburb','base_suburb'],['Jobs/day','daily_capacity'],['Active','active']] },
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
  document.querySelector('aside button[data-tab="due"]').click();
}

async function loadList() {
  const v = views[tab];
  let q = sb.from(v.table).select(v.select, { count: 'exact' })
    .order(v.order, { ascending: v.asc, nullsFirst: false })
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (term) q = q.ilike(v.search, `%${term}%`);
  const { data, count, error } = await q;
  if (error) return msg(error.message);
  msg('');
  const pages = Math.max(1, Math.ceil((count || 0) / PAGE));
  $('#pageInfo').textContent = ` Page ${page + 1} of ${pages} (${count} records) `;
  $('#prev').disabled = page === 0; $('#next').disabled = page + 1 >= pages;
  $('#list').innerHTML = '<tr>' + v.cols.map(c => `<th>${c[0]}</th>`).join('') + '</tr>' +
    data.map(r => `<tr${v.click ? ` class="click" data-id="${v.click === true ? r.id : r[v.click]}"` : ''}>` + v.cols.map(([, path, fmt, kind]) => {
      const val = get(r, path);
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
  $('#detailBody').innerHTML = `
    <h2>${esc(p.address_line)}, ${esc(p.suburb)} ${esc(p.postcode)}</h2>
    <p><b>Agency:</b> ${esc(p.clients?.name)} &nbsp; <b>Next due:</b> ${date(p.next_due)}<br>
    <b>Tenant:</b> ${esc(p.tenant_name)} ${esc(p.tenant_phone)} ${esc(p.tenant_email)}<br>
    <b>Lease:</b> ${date(p.lease_start)} → ${date(p.lease_end)}<br>
    <b>Notes:</b> ${esc(p.access_notes)}</p>
    <form id="breakdownForm"><input name="notes" placeholder="Breakdown details e.g. hallway alarm beeping" size="45" required><button>Log breakdown</button></form>
    <h3>Tenancies (${ten.length})</h3>
    <table><tr><th>Tenants</th><th>Mobile</th><th>Email</th><th>Move in</th><th>Lease</th><th>Vacate</th><th>PM</th></tr>
    ${ten.map(t => `<tr><td>${esc(t.tenant_names)}</td><td>${esc(t.mobile)}</td><td>${esc(t.email)}</td><td>${date(t.move_in)}</td>
      <td>${date(t.lease_start)} → ${leaseEnd(t.lease_end)}</td><td>${date(t.vacate_date)}</td><td>${esc(t.property_manager)}</td></tr>`).join('')}</table>
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
  $('#breakdownForm').onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.from('jobs').insert({ company_id: companyId, property_id: id, job_type: 'callout', status: 'to_book', notes: e.target.notes.value });
    if (error) return msg(error.message);
    msg('Breakdown logged – it is now in Schedule'); openProperty(id);
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
  }
  if (tab === 'due') loadDue(); else { if (tab === 'book') renderReady(); dayTicked.clear(); loadWeek(); }
}

// Grouped table used by both Due and Ready to book
// heading boxes: ticked if everything under them is ticked, dash if only some
function syncHeads(el) {
  el.querySelectorAll('[data-group]').forEach(h => {
    const kids = [...el.querySelectorAll('.pick.' + h.dataset.group)], on = kids.filter(c => c.checked).length;
    h.checked = kids.length > 0 && on === kids.length; h.indeterminate = on > 0 && on < kids.length;
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
  let html = '<tr><th></th><th>Address</th><th>Last done</th><th>Due</th><th>Notes</th></tr>', gi = 0;
  const walk = (node, lvl, ids) => {
    for (const k of order(node, keys[lvl])) {
      const id = which + (gi++), child = node[k], all = [...ids, id];
      html += `<tr class="${cls[lvl]}"><td><input type="checkbox" data-group="${id}"></td><td colspan="4" data-focus="${id}" data-label="${esc(k)}">${'&nbsp;&nbsp;'.repeat(lvl)}${esc(k)} — ${n(child)}</td></tr>`;
      if (Array.isArray(child)) {
        child.sort((x, y) => (x.suburb || '').localeCompare(y.suburb || '') || x.address_line.localeCompare(y.address_line));
        html += child.map(r => `<tr class="prow"><td><input type="checkbox" class="pick ${all.join(' ')}" data-key="${keyOf(r)}"${ticked[which].has(keyOf(r)) ? ' checked' : ''}></td>
          <td>${esc(r.address_line)}, ${esc(r.suburb)}</td><td>${date(r.last_done)}</td>
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
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease', sale: 'Sale', install: 'Install' };
  const unassigned = data.filter(j => !(j.job_type === 'callout' && j.status === 'to_book'))   // logged breakdowns live on Due
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

// selected board cell (the From day on Scheduled)
const pick = { ins: '', day: '' };
const onBoard = (ins, day) => weekJobs.filter(j => j.ins === ins && j.day === day).length;   // jobs already on that day

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
  msg(err ? 'Booking failed: ' + err.message : `Booked ${picks.length}`);
  Promise.all([renderReady(), loadWeek()]);
}

// Week board: inspectors down, days across; each cell = total + areas (count)
let weekJobs = [];   // cached jobs for the visible week
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
async function loadWeek() {
  const jobs = await fetchWeek(weekStart); if (!jobs) return;
  weekJobs = jobs; drawWeek(); openDay(); loadAlerts();
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
    inspectors.map(i => `<tr><th>${esc(i.name)}</th>${days.map(d => {
      const c = cell[i.id + '|' + d], over = c && c.total > i.daily_capacity;
      const sel = selIns === i.id && selDay === d ? ' class="sel"' : toIns === i.id && toDay === d ? ' class="to"' : '';
      return `<td data-ins="${i.id}" data-day="${d}"${sel}>${c ? `<div class="tot ${over ? 'over' : ''}">${c.total}/${i.daily_capacity}</div>` +
        Object.entries(c.areas).sort((x, y) => y[1].n - x[1].n).map(([a, v]) => `${esc(a)} (${v.n})` +
          Object.entries(v.agents).sort((x, y) => y[1] - x[1]).map(([g, k]) => `<br><i style="color:#555">&nbsp;&nbsp;${esc(g)} (${k})</i>`).join('')).join('<br>') : ''}</td>`;
    }).join('')}</tr>`).join('');
}
function drawWeek() {
  $('#wkLabel').textContent = ` Week of ${weekStart} `;
  document.querySelectorAll('.fromLbl').forEach(x => x.textContent = tab === 'scheduled' ? 'From – ' : '');
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

$('#week').onclick = e => {
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
  const label = { callout: 'Breakdown', annual: 'Annual', pre_tenancy: 'Lease' };
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
    data.map((j, i) => `<tr><td>${tab === 'scheduled' ? `<input type="checkbox" class="dpick" value="${j.id}"${dayTicked.has(j.id) ? ' checked' : ''}>` : i + 1}</td><td>${esc(j.properties?.address_line)}, ${esc(j.properties?.suburb)}</td>
      <td>${esc(j.properties?.clients?.name)}</td><td>${esc(areaOf[(j.properties?.suburb || '').trim().toUpperCase()] || '')}</td>
      <td>${label[j.job_type] || esc(j.job_type)}</td><td>${esc(j.status)}</td>
      <td>${j.status === 'booked' ? `<button data-unbook="${j.id}" data-type="${j.job_type}">Unbook</button>` : ''}</td><td>${esc(j.notes)}</td></tr>`).join('') + '</table></div>';
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
$('#doMove').onclick = () => {
  if (!to.ins) return msg('Click a day on the To board first');
  actOnTicked({ inspector_id: to.ins, scheduled_start: `${to.day}T09:00:00` },
    n => `Moved ${n} to ${inspectors.find(i => i.id === to.ins).name} on ${to.day}`);
};
$('#doUnbook').onclick = () => actOnTicked({ status: 'booked', inspector_id: null, scheduled_start: null, route_order: null }, n => `Unbooked ${n} – back in Ready to book`);
$('#doCancel').onclick = () => {
  if (!dayTicked.size || confirm(`Cancel ${dayTicked.size} jobs? Annual inspections go back to Due.`))
    actOnTicked({ status: 'cancelled' }, n => `Cancelled ${n}`);
};

const unbook = ids => sb.from('jobs').update({ status: 'booked', inspector_id: null, scheduled_start: null, route_order: null }).in('id', [].concat(ids));
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
const shiftWeek = n => { const d = new Date(weekStart + 'T00:00'); d.setDate(d.getDate() + n); weekStart = iso(d); drawWeek(); loadWeek(); };
$('#wkPrev').onclick = () => shiftWeek(-7);
$('#wkNext').onclick = () => shiftWeek(7);

// ---------- Messages (outbox) ----------
const msgTicked = new Set();
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
async function loadMessages() {
  loadAlerts();
  let q = sb.from('messages').select('id,kind,channel,to_name,to_address,subject,body,for_date,send_after,status,error,properties(address_line,suburb)')
    .order('send_after').limit(500);
  if ($('#msgStatus').value) q = q.eq('status', $('#msgStatus').value);
  const { data, error } = await q;
  if (error) return msg(error.message);
  msgTicked.clear();
  const kind = { entry_notice: 'Entry notice', entry_notice_changed: 'Entry notice – date changed' };
  $('#msgInfo').textContent = `${data.length} message${data.length === 1 ? '' : 's'}`;
  $('#msgList').innerHTML = '<tr><th><input type="checkbox" id="msgAll"></th><th>Send (Qld time)</th><th>Visit</th><th>To / subject</th><th>Message</th></tr>' +
    data.map(m => `<tr class="prow"><td><input type="checkbox" class="mpick" value="${m.id}"></td><td>${new Date(m.send_after).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td><td>${date(m.for_date)}</td>
      <td style="white-space:normal;width:22%"><b>${esc(m.to_name)}</b> <small>${esc(m.to_address || '— no email')}</small><br>
        ${esc(m.properties?.address_line)}, ${esc(m.properties?.suburb)} – ${kind[m.kind] || esc(m.kind)}${m.error ? `<br><small class="bad">${esc(m.error)}</small>` : ''}</td>
      <td style="white-space:pre-wrap;font-size:13px">${esc(m.body)}</td></tr>`).join('');
}
$('#msgStatus').onchange = loadMessages;
$('#msgList').onchange = e => {
  const boxes = e.target.id === 'msgAll' ? [...document.querySelectorAll('.mpick')] : e.target.classList.contains('mpick') ? [e.target] : [];
  boxes.forEach(c => { c.checked = e.target.checked; c.checked ? msgTicked.add(c.value) : msgTicked.delete(c.value); });
};
const setMsgStatus = async (status, label) => {
  if (!msgTicked.size) return msg('Tick some messages first');
  const { error } = await sb.from('messages').update({ status, error: null }).in('id', [...msgTicked]);
  msg(error ? error.message : `${label} ${msgTicked.size}`); loadMessages();
};
$('#msgNow').onclick = async () => {
  if (!msgTicked.size) return msg('Tick some messages first');
  const { error } = await sb.from('messages').update({ send_after: new Date().toISOString(), status: 'queued', error: null }).in('id', [...msgTicked]);
  msg(error ? error.message : `${msgTicked.size} set to send now (they'll go once a sending service is connected)`); loadMessages();
};
$('#msgCancel').onclick = () => setMsgStatus('cancelled', 'Cancelled');
$('#msgRequeue').onclick = () => setMsgStatus('queued', 'Re-queued');

// ---------- Templates ----------
const PLACEHOLDERS = ['Tenant greeting', 'Tenant names', 'Address', 'Suburb', 'Postcode', 'Visit date', 'Old visit date', 'Inspector', 'Company'];
let templates = [], tplField = null;
const sampleVars = () => ({ 'Tenant greeting': 'Sam & Alex', 'Tenant names': 'Sam Smith & Alex Jones', Address: '8 Aaron Street', Suburb: 'COOMERA',
  Postcode: '4209', 'Visit date': 'Tuesday 8 December 2026', 'Old visit date': 'Friday 4 December 2026', Inspector: 'Liam',
  Company: ($('#who').textContent.split(' · ')[0] || 'Your company') });
const fill = (t, v) => Object.entries(v).reduce((s, [k, x]) => s.split('{' + k + '}').join(x), t || '');
async function loadTemplates() {
  const { data, error } = await sb.from('templates').select('*').order('name');
  if (error) return msg(error.message);
  templates = data;
  const cur = $('#tplPick').value;
  $('#tplPick').innerHTML = data.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (cur) $('#tplPick').value = cur;
  $('#tplChips').innerHTML = PLACEHOLDERS.map(p => `<button type="button" data-ph="${p}">{${p}}</button>`).join('');
  showTemplate();
}
function showTemplate() {
  const t = templates.find(x => x.id === $('#tplPick').value); if (!t) return;
  $('#tplSubject').value = t.subject || ''; $('#tplBody').value = t.body || ''; $('#tplInfo').textContent = '';
  previewTemplate();
}
function previewTemplate() {
  const v = sampleVars();
  $('#tplPrevSubject').textContent = fill($('#tplSubject').value, v);
  $('#tplPrevBody').textContent = fill($('#tplBody').value, v);
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
document.querySelectorAll('aside button[data-tab]').forEach(b => b.onclick = () => {
  tab = b.dataset.tab; page = 0; term = ''; $('#search').value = '';
  document.querySelectorAll('aside button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
  $('#detail').classList.add('hidden');
  $('#weekArea').classList.toggle('hidden', !['book', 'scheduled'].includes(tab));
  $('#toArea').classList.toggle('hidden', tab !== 'scheduled');
  if (tab === 'scheduled') { $('#schedSide').append($('#toArea'), $('#dayView')); }
  else { $('#week').after($('#dayView')); }
  if (tab === 'settings') { $('#listArea').classList.add('hidden'); return loadCompany(); }
  if (tab === 'templates') { $('#listArea').classList.add('hidden'); return loadTemplates(); }
  if (tab === 'messages') { $('#listArea').classList.add('hidden'); return loadMessages(); }
  if (['due', 'book', 'scheduled'].includes(tab)) { $('#listArea').classList.add('hidden'); return openSchedule(); }
  $('#back').onclick();
});
$('#logout').onclick = async () => { await sb.auth.signOut(); show('login'); };

start();

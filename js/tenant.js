// Tenant page: tenant.html?t=<private link code>. No login – everything goes through tenant_portal_* functions,
// which only ever show this one tenancy (contacts partly hidden) and stop working 30 days after the visit.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const tok = new URLSearchParams(location.search).get('t');
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const say = t => { const m = $('#msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(say.t); say.t = setTimeout(() => m.style.display = 'none', 3500); };
const call = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, { tok, ...args });
  if (error || data?.error) { say(error?.message || data.error); return null; }
  return data;
};

async function load() {
  if (!/^[0-9a-f-]{36}$/i.test(tok || '')) return $('#app').innerHTML = '<div class="card">This link isn’t complete. Please use the link from your email.</div>';
  const d = await call('tenant_portal_get', {});
  if (!d) return;
  if (d.expired) return $('#app').innerHTML = '<div class="card"><h2>This link has expired</h2><p class="muted">Links work for 30 days around a visit. A new link comes with your next entry notice.</p></div>';
  $('#co').textContent = d.company; $('#coPhone').textContent = d.company_phone ? 'Questions? Call ' + d.company_phone : '';
  const visit = d.visit ? new Date(d.visit).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Australia/Brisbane' }) : '';
  const list = (main, extra, kind) => `<ul>${main ? `<li><span>${esc(main)}</span><span class="tag">main – contact us to change</span></li>` : ''}${extra.map((x, i) =>
    `<li><span>${esc(x)}</span><button class="x" data-rm="${kind}" data-i="${i + 1}">Remove</button></li>`).join('')}</ul>`;
  $('#app').innerHTML = `
    <h1>${esc(d.address)}</h1>
    <p class="muted">${esc(d.tenants)}${visit ? ` · Smoke alarm visit <b>${visit}</b>` : ''}</p>

    <div class="card"><h2>Notes for this visit</h2>
      <p class="muted">e.g. “Home 7–9am, otherwise please collect keys from the agent.”</p>
      <textarea id="visitNote" maxlength="1000">${esc(d.visit_note)}</textarea>
      <label>Permanent notes</label>
      <p class="muted">Kept for every future visit while you live here – pets, gate codes, access, parking.</p>
      <textarea id="tenantNotes" maxlength="2000">${esc(d.tenant_notes)}</textarea>
      <p><button id="saveNotes">Save notes</button></p></div>

    <div class="card"><h2>Emails for notices</h2>${list(d.main_email, d.emails, 'email')}
      <div class="row"><input id="newEmail" type="email" placeholder="Add another email"><button class="g" data-add="email">Add</button></div></div>

    <div class="card"><h2>Phone numbers</h2>${list(d.main_phone, d.phones, 'phone')}
      <div class="row"><input id="newPhone" type="tel" placeholder="Add another phone"><button class="g" data-add="phone">Add</button></div></div>

    <div class="card"><h2>See your full details</h2>
      <p class="muted">For your privacy, details are partly hidden here. We can email the full list to the main email on file.</p>
      <button class="g" id="sendDetails">Email me my full details</button></div>
    <p class="muted">Everyone already on file is told by email when contact details change.</p>`;
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'saveNotes') {
    b.disabled = true;
    if (await call('tenant_portal_save_notes', { p_tenant_notes: $('#tenantNotes').value, p_visit_note: $('#visitNote').value })) say('Notes saved – thank you');
    b.disabled = false;
  } else if (b.dataset.add) {
    const inp = b.dataset.add === 'email' ? $('#newEmail') : $('#newPhone');
    if (!inp.value.trim()) return inp.focus();
    b.disabled = true;
    if (await call('tenant_portal_contact', { p_kind: b.dataset.add, p_action: 'add', p_value: inp.value })) { say('Added'); load(); }
    b.disabled = false;
  } else if (b.dataset.rm) {
    if (!confirm('Remove this ' + b.dataset.rm + '?')) return;
    if (await call('tenant_portal_contact', { p_kind: b.dataset.rm, p_action: 'remove', p_value: '', p_index: +b.dataset.i })) { say('Removed'); load(); }
  } else if (b.id === 'sendDetails') {
    b.disabled = true;
    const r = await call('tenant_portal_send_details', {});
    if (r) say('We\'ll email it to ' + r.sent_to + ' with our next send');
  }
});
load();

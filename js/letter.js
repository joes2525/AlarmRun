// Printable entry notice letters: letter.html?ids=<message id>,<message id>...
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean);
  if (!ids.length) return $('#msg').textContent = 'No letters selected';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return $('#msg').textContent = 'Please log in to the office app first';
  const { data, error } = await sb.from('messages').select('id,company_id,to_name,to_address,subject,body,channel').in('id', ids);
  if (error) return $('#msg').textContent = error.message;
  const letters = data.filter(m => m.channel === 'mail');
  const { data: co } = letters.length ? await sb.from('companies').select('name,sender_name,phone,reply_to_email,abn').eq('id', letters[0].company_id).single() : { data: null };
  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
  $('#count').textContent = `${letters.length} letter${letters.length === 1 ? '' : 's'}`;
  $('#letters').innerHTML = letters.map(m => `<div class="letter">
    <div class="from"><b>${esc(co?.sender_name || co?.name)}</b><br>${co?.phone ? esc(co.phone) + '<br>' : ''}${co?.reply_to_email ? esc(co.reply_to_email) + '<br>' : ''}${co?.abn ? 'ABN ' + esc(co.abn) : ''}</div>
    <div class="to">${esc(m.to_name || 'The Occupant')}<br>${esc(m.to_address).split(', ').join('<br>')}</div>
    <div class="date">${today}</div>
    <div class="subject">${esc(m.subject)}</div>
    <div class="body">${esc(m.body)}</div>
  </div>`).join('') || '<p style="text-align:center">None of the selected messages are letters.</p>';
})();

"""Smoke test: loads the app in headless Chrome against a fake Supabase and clicks through
every page and the main scheduling flows. Fails on any JavaScript error.

Run:  python3 tests/smoke.py
"""
import http.server, threading, functools, os, sys, datetime as dt
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
monday = dt.date.today() - dt.timedelta(days=dt.date.today().weekday())
day = lambda n: (monday + dt.timedelta(days=n)).isoformat()

FAKE = r"""
window.__DATA = {
  memberships: [{ company_id: 'c1', companies: { name: 'Test Co' } }],
  companies: [{ name: 'Test Co', sender_name: 'Test Co', sender_code: 'test', reply_to_email: 't@x.com' }],
  inspectors: [{ id: 'i1', name: 'Liam', daily_capacity: 18 }, { id: 'i2', name: 'Grant', daily_capacity: 18 }],
  suburb_areas: [{ suburb: 'COOMERA', area: 'Coomera Area' }],
  schedule_queue: [
    { reason: 'Annual', property_id: 'p1', job_id: null, address_line: '1 Test St', suburb: 'COOMERA', postcode: '4209', agency: 'Evolve', area: 'Coomera Area', last_done: '2025-01-01', due_date: '2026-01-01', notes: null },
    { reason: 'Breakdown', property_id: 'p2', job_id: 'j9', address_line: '2 Test St', suburb: 'COOMERA', postcode: '4209', agency: 'Evolve', area: 'Coomera Area', last_done: null, due_date: '2026-01-02', notes: 'Beeping' }],
  jobs: [{ id: 'j1', inspector_id: 'i1', scheduled_start: '%DAY%T09:00:00+00:00', job_type: 'annual', status: 'booked', notes: null, route_order: 1,
           property_id: 'p3', properties: { address_line: '3 Test St', suburb: 'COOMERA', postcode: '4209', clients: { name: 'Evolve' } } }],
  messages: [{ id: 'm1', kind: 'entry_notice', to_name: 'Sam', to_address: 's@x.com', subject: 'Entry notice', body: 'Hi {x}', for_date: '%DAY%', send_after: '%DAY%T09:00:00Z', status: 'queued', properties: { address_line: '3 Test St', suburb: 'COOMERA' } }],
  notice_alerts: [{ job_id: 'j1', visit: '%DAY%', inspector: 'Liam', address_line: '3 Test St', suburb: 'COOMERA', problem: 'No entry notice for this visit date' }],
  templates: [{ id: 't1', name: 'Entry notice', subject: 'Entry {Address}', body: 'Hi {Tenant greeting}' }],
};
window.__CALLS = [];
function builder(table) {
  let single = false;
  const b = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res) => res({ data: single ? (window.__DATA[table] || [])[0] || {} : (window.__DATA[table] || []), error: null, count: (window.__DATA[table] || []).length });
    if (k === 'single') return () => { single = true; return b; };
    return (...args) => { window.__CALLS.push([table, k]); return b; };
  }});
  return b;
}
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { email: 'test@x.com' } } } }), signOut: async () => ({}) },
  from: builder, rpc: async () => ({ error: null }),
}) };
"""

def main():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_port}/index.html'
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
        page = b.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: m.type == 'error' and errors.append(f'console: {m.text}'))
        page.on('dialog', lambda d: d.accept())
        page.route('**/supabase-js@2', lambda r: r.fulfill(body='', content_type='text/javascript'))
        page.route('**/config.js', lambda r: r.fulfill(body="window.SUPABASE_URL='x';window.SUPABASE_KEY='y';", content_type='text/javascript'))
        page.add_init_script(FAKE.replace('%DAY%', day(1)))
        page.goto(url); page.wait_for_timeout(600)

        def step(name, fn):
            before = len(errors)
            try: fn(); page.wait_for_timeout(250)
            except Exception as e: errors.append(f'{name}: {e}')
            print(('FAIL ' if len(errors) > before else 'ok   ') + name)

        tab = lambda t: page.click(f'aside button[data-tab="{t}"]')
        step('Due page loads', lambda: tab('due'))
        step('Tick a due group', lambda: page.locator('#dueList input[data-group]').first.check())
        step('Move to Book', lambda: page.click('#toBook'))
        step('Book page loads', lambda: tab('book'))
        step('Tick ready group', lambda: page.locator('#readyList input[data-group]').first.check())
        step('This week button', lambda: page.click('[data-wk="0"]'))
        step('Pick a board day', lambda: page.locator('#week td[data-day]').nth(1).click())
        step('Book', lambda: page.click('#doBook'))
        step('Book saved to jobs', lambda: None if page.evaluate("__CALLS.some(c => c[0]==='jobs' && ['insert','update'].includes(c[1]))") else errors.append('Book: no insert/update sent'))
        step('Unbook day', lambda: page.click('#unbookDay'))
        step('Scheduled page loads', lambda: tab('scheduled'))
        step('Pick From day', lambda: page.locator('#week td[data-day]').nth(1).click())
        step('Pick To day', lambda: page.locator('#week td[data-day]').nth(3).click())
        step('Move', lambda: page.click('#doMove'))
        step('Move saved', lambda: None if page.evaluate("__CALLS.filter(c => c[0]==='jobs' && c[1]==='update').length >= 2") else errors.append('Move: no update sent'))
        step('Messages page', lambda: tab('messages'))
        step('Templates page', lambda: tab('templates'))
        step('Insert placeholder', lambda: page.locator('#tplChips button').first.click())
        step('Settings page', lambda: tab('settings'))
        for t in ['clients', 'properties', 'tenants', 'jobs', 'certificates', 'invoices', 'inspectors']:
            step(f'{t} list', lambda t=t: tab(t))
        b.close()
    srv.shutdown()
    print('\n' + ('\n'.join(errors) if errors else 'ALL PASSED'))
    sys.exit(1 if errors else 0)

if __name__ == '__main__':
    main()

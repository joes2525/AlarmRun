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
  memberships: [{ company_id: 'c1', role: 'owner', companies: { name: 'Test Co' } }],
  companies: [{ name: 'Test Co', sender_name: 'Test Co', sender_code: 'test', reply_to_email: 't@x.com' }],
  inspectors: [{ id: 'i1', name: 'Liam', daily_capacity: 18 }, { id: 'i2', name: 'Grant', daily_capacity: 18 }],
  suburb_areas: [{ suburb: 'COOMERA', area: 'Coomera Area' }],
  schedule_queue: [
    { reason: 'Annual', property_id: 'p1', job_id: null, address_line: '1 Test St', suburb: 'COOMERA', postcode: '4209', agency: 'Evolve', area: 'Coomera Area', last_done: '2025-01-01', due_date: '2026-01-01', notes: null },
    { reason: 'Breakdown', property_id: 'p2', job_id: 'j9', address_line: '2 Test St', suburb: 'COOMERA', postcode: '4209', agency: 'Evolve', area: 'Coomera Area', last_done: null, due_date: '2026-01-02', notes: 'Beeping' }],
  jobs: [{ id: 'j1', inspector_id: 'i1', scheduled_start: '%DAY%T09:00:00+00:00', job_type: 'annual', status: 'booked', notes: null, route_order: 1,
           property_id: 'p3', properties: { address_line: '3 Test St', suburb: 'COOMERA', postcode: '4209', storeys: 2, bedrooms: 3, clients: { name: 'Evolve' } },
           company_id: 'c1', completed_at: '%DAY%T05:00:00Z', inspectors: { name: 'Liam' }, blind_cleats: 'Installed', blind_cleats_needed: 2, safety_switch: 'Tested OK',
           certificates: [{ number: 'AASA-00001', compliant: true, issued_at: '%DAY%T05:00:00Z' }],
           alarm_checks: [{ action: 'Serviced', alarms: { location: 'Hallway', sensor_type: 'Photoelectric', power_source: 'hardwired', manufacture_date: '2021-03-01', expiry_date: '2031-03-01' } },
                          { action: 'Replaced', replace_reason: 'Broken', quote: 'Upgrade', photo_path: 'c1/j1/a.jpg', alarms: { location: 'Bedroom 1', sensor_type: 'Photoelectric', power_source: '10yr_lithium', manufacture_date: '2026-06-01', expiry_date: '2036-06-01' } }] }],
  messages: [{ id: 'm1', kind: 'entry_notice', to_name: 'Sam', to_address: 's@x.com', subject: 'Entry notice', body: 'Hi {x}', for_date: '%DAY%', send_after: '%DAY%T09:00:00Z', status: 'queued', properties: { address_line: '3 Test St', suburb: 'COOMERA' } }],
  notice_alerts: [{ job_id: 'j1', visit: '%DAY%', inspector: 'Liam', address_line: '3 Test St', suburb: 'COOMERA', problem: 'No entry notice for this visit date' }],
  alarms: [{ id: 'a1', location: 'Hallway', storey: 1, sensor_type: 'photoelectric', power_source: 'hardwired', brand: 'Clipsal', expiry_date: '2030-01-01' },
           { id: 'a2', location: 'Bedroom 1', storey: 1, sensor_type: 'photoelectric', power_source: '9v', brand: 'Brooks', expiry_date: '2020-01-01' }],
  tenancies: [{ tenant_names: 'Sam Smith', mobile: '0400 000 000', email: 's@x.com' }],
  price_items: [{ id: 'x1', kind: 'action', name: 'Serviced', price: 85, active: true }, { id: 'x2', kind: 'action', name: 'Replaced', price: 120, active: true },
    { id: 'x3', kind: 'quote', name: 'Upgrade', price: 150, active: true }, { id: 'x4', kind: 'location', name: 'Bedroom 2', active: true },
    { id: 'x5', kind: 'device_type', name: 'Photoelectric', active: true }, { id: 'x6', kind: 'device_type', name: 'Alarm controller', active: true },
    { id: 'x7', kind: 'replace_reason', name: 'Under warranty', price: 0, active: true }],
  completed_summary: [{ id: 'j5', status: 'completed', outcome: 'compliant', done_at: '%DAY%T05:00:00Z', address_line: '5 Test St', suburb: 'COOMERA', agency: 'Evolve', inspector: 'Liam', compliant: true, certificate: 'C1', actions: 'Serviced ×4, Replaced (Broken) ×1', quotes: 'Upgrade – Hallway', has_invoice: true, has_quote: true, blind_cleats: 'Installed', blind_cleats_needed: 2 },
    { id: 'j6', status: 'no_access', done_at: '%DAY%T05:00:00Z', address_line: '6 Test St', suburb: 'COOMERA', agency: 'Evolve', inspector: 'Liam', comment: 'No one home', has_invoice: false, has_quote: false }],
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
  auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'test@x.com' } } } }), getUser: async () => ({ data: { user: { id: 'u1' } } }), signOut: async () => ({}) },
  from: builder, rpc: async (fn, args) => { window.__CALLS.push(['rpc', fn, args]); return { data: 'C123', error: null }; },
  storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrls: async (paths) => ({ data: paths.map(() => ({ signedUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22%3E%3Crect width=%22300%22 height=%22200%22 fill=%22%23b8c4d0%22/%3E%3C/svg%3E' })) }) }) },
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
        page.route('**/config.js*', lambda r: r.fulfill(body="window.SUPABASE_URL='x';window.SUPABASE_KEY='y';", content_type='text/javascript'))
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
        step('Completed page', lambda: (tab('completed'), page.wait_for_selector('#doneLists details', timeout=2000)))
        step('Completed shows rows', lambda: None if page.locator('#doneLists tr.prow').count() >= 3 else errors.append('Completed: expected rows in Invoices, Quotes, No access'))
        step('Approve a job', lambda: page.locator('#doneLists [data-appr]').first.click())
        step('Approve saved', lambda: None if page.evaluate("__CALLS.some(c => c[0]==='jobs' && c[1]==='update')") else errors.append('Approve: no update sent'))
        step('Messages page', lambda: tab('messages'))
        step('Templates page', lambda: tab('templates'))
        step('Insert placeholder', lambda: page.locator('#tplChips button').first.click())
        step('Settings page', lambda: tab('settings'))
        step('Prices page', lambda: (tab('prices'), page.wait_for_selector('#pxLists input[data-f="price"]', timeout=2000)))
        step('Edit a price and save', lambda: (page.fill('#pxLists input[data-f="price"]', '90'), page.click('#pxSave')))
        for t in ['clients', 'properties', 'tenants', 'jobs', 'certificates', 'invoices', 'inspectors']:
            step(f'{t} list', lambda t=t: tab(t))
        # ---- certificate preview ----
        c = b.new_page(viewport={'width': 900, 'height': 1300})
        c.on('pageerror', lambda e: errors.append(f'cert pageerror: {e}'))
        c.route('**/supabase-js@2', lambda r: r.fulfill(body='', content_type='text/javascript'))
        c.route('**/config.js*', lambda r: r.fulfill(body="window.SUPABASE_URL='x';window.SUPABASE_KEY='y';", content_type='text/javascript'))
        c.add_init_script(FAKE.replace('%DAY%', day(1)))
        c.goto(url.replace('index.html', 'cert.html?job=j1')); c.wait_for_timeout(600)
        step('Certificate shows photos', lambda: None if c.locator('.pics img').count() == 1 else errors.append('Certificate photos missing'))
        step('Certificate renders', lambda: None if 'COMPLIANT' in c.inner_text('#cert') and 'AASA-00001' in c.inner_text('#cert') else errors.append('Certificate did not render'))
        c.screenshot(path='/tmp/cert-preview.png', full_page=True)

        # ---- inspector phone app ----
        m = b.new_page(viewport={'width': 390, 'height': 844})
        m.on('pageerror', lambda e: errors.append(f'tech pageerror: {e}'))
        m.on('console', lambda x: x.type == 'error' and errors.append(f'tech console: {x.text}'))
        m.on('dialog', lambda d: d.accept('No one home') if d.type == 'prompt' else d.accept())
        m.route('**/supabase-js@2', lambda r: r.fulfill(body='', content_type='text/javascript'))
        m.route('**/config.js*', lambda r: r.fulfill(body="window.SUPABASE_URL='x';window.SUPABASE_KEY='y';", content_type='text/javascript'))
        m.add_init_script(FAKE.replace('%DAY%', day(1)))
        m.goto(url.replace('index.html', 'tech.html')); m.wait_for_timeout(600)
        def mstep(name, fn):
            before = len(errors)
            try: fn(); m.wait_for_timeout(250)
            except Exception as e: errors.append(f'{name}: {e}')
            print(('FAIL ' if len(errors) > before else 'ok   ') + name)
        mstep('Tech: run list shows a job', lambda: m.wait_for_selector('#jobs [data-job]', timeout=3000))
        mstep('Tech: open job', lambda: m.click('#jobs [data-job]'))
        mstep('Tech: items listed with actions', lambda: m.wait_for_selector('[data-act="Serviced"]', timeout=3000))
        mstep('Tech: Serviced on item 1', lambda: m.locator('[data-i="0"][data-act="Serviced"]').click())
        mstep('Tech: Replaced on item 2', lambda: m.locator('[data-i="1"][data-act="Replaced"]').click())
        mstep('Tech: replacement fields', lambda: (m.select_option('[data-i="1"][data-f="replace_reason"]', 'Under warranty'), m.select_option('[data-i="1"][data-f="new_type"]', 'Photoelectric')))
        mstep('Tech: quote on item 2', lambda: m.select_option('[data-i="1"][data-f="quote"]', 'Upgrade'))
        mstep('Tech: add controller', lambda: (m.click('#addOpen'), m.select_option('#adLoc', 'Bedroom 2'), m.select_option('#adType', 'Alarm controller'), m.select_option('#adAct', 'Serviced'), m.click('#adSave')))
        mstep('Tech: blind cleats + safety switch', lambda: (m.click('[data-x="blind_cleats"][data-v="Installed"]'), m.fill('[data-xi="blind_cleats_needed"]', '2'),
              m.locator('[data-xi="blind_cleats_needed"]').dispatch_event('change'), m.click('[data-x="safety_switch"][data-v="Tested OK"]')))
        mstep('Tech: property details', lambda: (m.select_option('[data-xi="ceiling_access"]', 'Limited'), m.fill('[data-xi="bedrooms"]', '3'), m.locator('[data-xi="bedrooms"]').dispatch_event('change')))
        mstep('Tech: Non-compliant', lambda: m.click('[data-finish="non_compliant"]'))
        def check_rpc():
            call = m.evaluate("__CALLS.find(c => c[0]==='rpc' && c[1]==='complete_job')")
            if not call: return errors.append('Tech: complete_job not called')
            a = call[2]; items = a['p_items']
            ok = (a['p_outcome'] == 'non_compliant' and len(items) == 3 and items[0]['action'] == 'Serviced' and items[1]['action'] == 'Replaced'
                  and items[1]['quote'] == 'Upgrade' and items[2]['device_type'] == 'Alarm controller' and items[2]['alarm_id'] is None
                  and a['p_extra']['blind_cleats'] == 'Installed' and items[1]['replace_reason'] == 'Under warranty' and items[1]['device_type'] == 'Photoelectric' and a['p_extra']['blind_cleats_needed'] == '2' and a['p_extra']['ceiling_access'] == 'Limited')
            if not ok: errors.append(f'Tech: wrong data sent {a}')
        mstep('Tech: complete_job sent right data', check_rpc)
        mstep('Tech: back to run', lambda: m.wait_for_selector('#run:not([hidden])', timeout=3000))
        b.close()
    srv.shutdown()
    print('\n' + ('\n'.join(errors) if errors else 'ALL PASSED'))
    sys.exit(1 if errors else 0)

if __name__ == '__main__':
    main()

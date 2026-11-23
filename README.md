# AlarmRun – office web app

Scheduling and compliance software for Queensland smoke alarm checking companies.

- `index.html` – page layout
- `css/app.css` – styling
- `js/app.js` – app logic (vanilla JS + supabase-js)
- `config.js` – public Supabase URL and publishable key
- `sql/` – database changes, run in number order in the Supabase SQL Editor
- `tests/smoke.py` – clicks through every page in headless Chrome against a fake database; runs automatically on every push (GitHub Actions)

-- Fortnightly availability per inspector: 14 days = Week 1 Mon..Sun, Week 2 Mon..Sun
-- Week 1 = the week starting Monday 5 Jan 2026, then alternating
alter table inspectors add column if not exists availability jsonb not null
  default '[true,true,true,true,true,false,false,true,true,true,true,true,false,false]';

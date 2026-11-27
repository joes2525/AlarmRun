-- Bank details and payment terms for tax invoices
alter table companies add column if not exists bank_account_name text;
alter table companies add column if not exists bank_bsb text;
alter table companies add column if not exists bank_account_number text;
alter table companies add column if not exists payment_terms_days int not null default 14;
grant update (bank_account_name, bank_bsb, bank_account_number, payment_terms_days) on companies to authenticated;

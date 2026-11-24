-- Sending: retry count and the provider's message id
alter table messages add column if not exists attempts int not null default 0;
alter table messages add column if not exists provider_id text;
alter table messages add column if not exists delivered_at timestamptz;

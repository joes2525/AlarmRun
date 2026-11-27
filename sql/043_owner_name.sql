-- Property owner's name (for agent-managed properties). Certificates show "Owner: <name>", or "c/- <agency>" if blank.
alter table properties add column if not exists owner_name text;

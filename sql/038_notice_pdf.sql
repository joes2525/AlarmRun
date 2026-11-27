-- Copy of the Form 9 PDF sent with each entry notice (path in the private 'photos' bucket)
alter table messages add column if not exists attachment_path text;

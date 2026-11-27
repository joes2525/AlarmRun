-- Visit hours in all message wording: 8am to 5pm (matches the Form 9)
update templates set
  body = regexp_replace(body, '8\s*am( and | to | ?[-–] ?)4\s*pm', '8am\1' || '5pm', 'gi'),
  subject = regexp_replace(subject, '8\s*am( and | to | ?[-–] ?)4\s*pm', '8am\1' || '5pm', 'gi')
where body ~* '8\s*am( and | to | ?[-–] ?)4\s*pm' or subject ~* '8\s*am( and | to | ?[-–] ?)4\s*pm';
-- notices already queued but not yet sent
update messages set body = regexp_replace(body, '8\s*am( and | to | ?[-–] ?)4\s*pm', '8am\1' || '5pm', 'gi')
where status = 'queued' and body ~* '8\s*am( and | to | ?[-–] ?)4\s*pm';

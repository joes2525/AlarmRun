-- Entry notice emails: the tenant link goes right under the pets/access line
update templates set body = replace(replace(body,
    E'\n\nUpdate your contact details or leave notes for our technician (pets, access, best times): {Tenant link}', ''),
    'If you have pets or access instructions, please reply to this email.',
    E'If you have pets or access instructions, please click the link below:\n{Tenant link}')
where channel = 'email' and kind like 'entry_notice%';
-- any template where the pets line had been edited away: keep the link at the end
update templates set body = body || E'\n\nIf you have pets or access instructions, please click the link below:\n{Tenant link}'
where channel = 'email' and kind like 'entry_notice%' and body not like '%{Tenant link}%';

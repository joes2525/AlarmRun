-- Inspector contact details (test values)
alter table inspectors add column if not exists email text;

update inspectors set
  email = case name
    when 'Ethan Walker' then 'joes25+ethan@gmail.com'  when 'Mia Thompson' then 'joes25+mia@gmail.com'
    when 'Jack Wilson'  then 'joes25+jack@gmail.com'   when 'Chloe Nguyen' then 'joes25+chloe@gmail.com'
    when 'Oliver Brown' then 'joes25+oliver@gmail.com' else email end,
  phone = '0434997201',
  base_suburb = case name
    when 'Ethan Walker' then 'Coomera'      when 'Mia Thompson' then 'Chermside'
    when 'Jack Wilson'  then 'Logan Central' when 'Chloe Nguyen' then 'Ipswich'
    when 'Oliver Brown' then 'Indooroopilly' else base_suburb end;

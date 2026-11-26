-- Property photo: 'img/houses/NN.jpg' (sample, in the site) or a path in the private 'photos' bucket
alter table properties add column if not exists photo text;
-- give sample properties one of the 10 sample photos
update properties set photo = 'img/houses/' || lpad((1 + abs(hashtext(id::text)) % 10)::text, 2, '0') || '.jpg'
where photo is null;

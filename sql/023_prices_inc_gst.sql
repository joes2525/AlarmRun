-- Prices on the Prices page are now entered INCLUDING GST (GST = price / 11)
comment on column price_items.price is 'Price including GST';
comment on column alarm_checks.action_price is 'Price including GST at the time of the job';
comment on column alarm_checks.quote_price is 'Price including GST at the time of the job';

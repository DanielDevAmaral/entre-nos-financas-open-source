ALTER TABLE bank_card_bills ALTER COLUMN total_cents DROP NOT NULL, ALTER COLUMN charges_cents DROP NOT NULL;
ALTER TABLE bank_card_bills ADD COLUMN raw_total text NOT NULL DEFAULT '', ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
UPDATE bank_card_bills SET raw_total=(total_cents::numeric/100)::text WHERE raw_total='';

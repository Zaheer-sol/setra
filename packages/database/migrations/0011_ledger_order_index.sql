-- General ledger pages are read in ledger order (entry date, then entry id). This index lets a page
-- walk posted entries in that order and stop after the rows it needs, instead of joining and sorting
-- every line in the books. Environment is left out on purpose: under row-level security Postgres
-- can't use an enum comparison as an index condition, so a leading environment column would lose
-- the ordering; it's applied as a filter instead.
CREATE INDEX journal_entries_ledger_order ON journal_entries (organization_id, entry_date, id) WHERE status = 'posted';

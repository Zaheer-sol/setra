-- A books publication can carry the books themselves (encrypted in the business's browser) and public
-- statements (totals anyone can read). Record which it carried, and the statements as published.
ALTER TABLE books_attestations ADD COLUMN has_encrypted_books boolean NOT NULL DEFAULT false;
ALTER TABLE books_attestations ADD COLUMN statements jsonb;

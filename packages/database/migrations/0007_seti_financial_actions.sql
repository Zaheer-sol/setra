-- Seti can prepare financial records for confirmation: expenses, vendor bills and closing a period.
-- (Every one still requires the user's explicit confirmation and runs through the same API routes
-- and permissions as the console.)
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check
  CHECK (kind IN ('create_payment_request', 'correct_payment', 'create_customer', 'record_expense', 'record_bill', 'close_period'));

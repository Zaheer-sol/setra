-- Seti can prepare a classification of money Setra couldn't explain on its own ("the $740 was an owner
-- contribution"). Like every Seti action it waits for the user's confirmation and runs through the
-- same API route and permissions as the console.
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check
  CHECK (kind IN ('create_payment_request', 'correct_payment', 'create_customer', 'record_expense', 'record_bill', 'close_period', 'classify_transaction'));

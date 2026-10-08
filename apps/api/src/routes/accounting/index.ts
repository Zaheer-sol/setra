import type { FastifyInstance } from "fastify";
import { accountingMethodRoutes } from "./accounting-method";
import { periodRoutes } from "./periods";
import { ledgerAccountRoutes } from "./ledger-accounts";
import { journalEntryRoutes } from "./journal-entries";
import { reportRoutes } from "./reports";
import { booksHealthRoutes } from "./books-health";
import { classificationRoutes } from "./classifications";
import { vendorRoutes } from "./vendors";
import { billRoutes } from "./bills";
import { expenseRoutes } from "./expenses";
import { exchangeRateRoutes } from "./exchange-rates";
import { networkFeeRoutes } from "./network-fees";
import { bankReconciliationRoutes } from "./bank-reconciliation";
import { customerCreditRoutes } from "./customer-credits";
import { creditNoteRoutes } from "./credit-notes";
import { openingBalanceRoutes } from "./opening-balances";
import { yearEndRoutes } from "./year-end";
import { accountantExportRoutes } from "./accountant-exports";
import { attachmentRoutes } from "./attachments";
import { recurringBillRoutes } from "./recurring-bills";
import { monthCloseRoutes } from "./month-close";
import { booksAttestationRoutes } from "./books-attestation";

/** Every accounting route: the books, payables, and the tools around them. */
export function accountingRoutes(app: FastifyInstance) {
  accountingMethodRoutes(app);
  periodRoutes(app);
  ledgerAccountRoutes(app);
  journalEntryRoutes(app);
  reportRoutes(app);
  booksHealthRoutes(app);
  classificationRoutes(app);
  vendorRoutes(app);
  billRoutes(app);
  expenseRoutes(app);
  exchangeRateRoutes(app);
  networkFeeRoutes(app);
  bankReconciliationRoutes(app);
  customerCreditRoutes(app);
  creditNoteRoutes(app);
  openingBalanceRoutes(app);
  yearEndRoutes(app);
  accountantExportRoutes(app);
  attachmentRoutes(app);
  recurringBillRoutes(app);
  monthCloseRoutes(app);
  booksAttestationRoutes(app);
}

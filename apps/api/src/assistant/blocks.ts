/**
 * Assistant replies are structured blocks, rendered as cards by the console. They carry data, never
 * markup, so names and purposes typed by merchants or customers can't inject anything into the page.
 * Links are relative console paths.
 */

export type Row = [label: string, value: string];
export type Link = { label: string; href: string };

export type Block =
  | { type: "text"; text: string }
  | { type: "notice"; tone: "info" | "warning" | "danger" | "success"; title: string; text?: string; link?: Link }
  | { type: "choice"; prompt: string; options: Array<{ label: string; detail?: string; value: string }> }
  | { type: "confirm"; actionId: string; title: string; rows: Row[]; confirmLabel: string; testMode: boolean; expiresAt: string }
  | { type: "payment_request"; invoice: InvoiceCard; testMode: boolean }
  | { type: "payment"; title: string; tone: "success" | "warning" | "info" | "danger"; payment: PaymentCard; note?: string }
  | { type: "payments"; title: string; items: PaymentCard[]; empty: string; link?: Link }
  | { type: "invoices"; title: string; items: InvoiceCard[]; empty: string; total?: string; link?: Link }
  | { type: "summary"; title: string; rows: Row[]; highlight: { label: string; value: string }; link?: Link; note?: string }
  | { type: "exceptions"; title: string; items: ExceptionCard[]; empty: string; link?: Link }
  | { type: "record"; title: string; rows: Row[]; links: Link[] };

export interface InvoiceCard {
  id: string;
  number: string;
  title: string | null;
  purpose: string | null;
  customer: string;
  amount: string;
  remaining: string;
  asset: string;
  network: string;
  status: string;
  due_at: string | null;
  payment_url: string;
  line_items: Array<{ description: string; quantity: number; amount: string }>;
  href: string;
}

export interface PaymentCard {
  id: string;
  customer: string | null;
  purpose: string | null;
  purpose_status: string;
  invoice: string | null;
  amount: string;
  asset: string;
  network: string;
  status: string;
  status_label: string;
  transaction_hash: string;
  explorer_url: string | null;
  received_at: string;
  simulated: boolean;
  href: string;
}

export interface ExceptionCard {
  id: string;
  type: string;
  summary: string;
  amount: string | null;
  customer: string | null;
  invoice: string | null;
  href: string;
}

import nodemailer, { type Transporter } from "nodemailer";
import { appEnv } from "@setra/config";

let transport: Transporter | null | undefined;

/**
 * Transactional email (password reset, invitations). With SMTP_URL configured, mail is sent.
 * Without it, development logs the message (including the link) so flows can be completed locally;
 * production refuses to log secrets and only records that email is not configured.
 */
export async function sendEmail(message: { to: string; subject: string; text: string }, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const env = appEnv();
  if (transport === undefined) transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
  if (transport) {
    await transport.sendMail({ from: env.EMAIL_FROM, to: message.to, subject: message.subject, text: message.text });
    return { delivered: true };
  }
  if (env.isProduction) {
    log.warn({ to: message.to, subject: message.subject }, "email not sent: SMTP_URL is not configured");
    return { delivered: false };
  }
  log.info({ to: message.to, subject: message.subject, body: message.text }, "development email (SMTP_URL not set)");
  return { delivered: false };
}

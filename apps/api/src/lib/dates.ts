import { isoDate } from "@setra/engine";

/** Today as YYYY-MM-DD (UTC). */
export const today = () => isoDate(new Date());

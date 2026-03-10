/**
 * NYSE trading calendar service.
 *
 * Primary: `date-holidays` npm package with NYSE locale — no API key, offline.
 * Fallback: hardcoded 2026 NYSE holiday/early-close lists from config.ts.
 *
 * All functions operate in America/New_York time.
 */

import Holidays from "date-holidays";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { config } from "../config.js";
import { logger } from "../logger.js";

const TZ = "America/New_York";

// Initialise date-holidays with NYSE locale once (lazy)
let hd: Holidays | null = null;
function getHolidays(): Holidays | null {
  if (hd) return hd;
  try {
    hd = new Holidays("NYSE");
    return hd;
  } catch (err) {
    logger.warn({ err }, "date-holidays NYSE init failed; will use hardcoded fallback");
    return null;
  }
}

/** Format a Date as YYYY-MM-DD in ET. */
function toETDateString(date: Date): string {
  return formatInTimeZone(date, TZ, "yyyy-MM-dd");
}

/** Return true if the given date falls on a Saturday or Sunday (ET). */
function isWeekend(date: Date): boolean {
  const nyDate = toZonedTime(date, TZ);
  const dow = nyDate.getDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

/** Return true if the given date is a full NYSE holiday (market closed all day). */
function isNyseHoliday(date: Date): boolean {
  const dateStr = toETDateString(date);

  const holidays = getHolidays();
  if (holidays) {
    try {
      const result = holidays.isHoliday(toZonedTime(date, TZ));
      if (result !== false) {
        // date-holidays returns an array of matching holidays; check for full close
        const entries = Array.isArray(result) ? result : [result];
        const isFullClose = entries.some(
          (h: { type?: string }) =>
            h.type === "public" || h.type === "optional" || h.type === "school"
        );
        if (isFullClose) return true;
      }
    } catch (err) {
      logger.warn({ err, dateStr }, "date-holidays lookup error; falling back to hardcoded list");
    }
  }

  // Hardcoded fallback: check 2026 list
  return config.nyseHolidays2026.includes(dateStr as (typeof config.nyseHolidays2026)[number]);
}

/** Return true if NYSE closes early (1:00 PM ET) on this day. */
export function isEarlyClose(date: Date): boolean {
  const dateStr = toETDateString(date);
  // Rely on hardcoded list for early closes — date-holidays doesn't have reliable
  // NYSE-specific early-close data
  return config.nyseEarlyClose2026.includes(
    dateStr as (typeof config.nyseEarlyClose2026)[number]
  );
}

/** Return true if the given date is a full NYSE trading day (not weekend, not holiday). */
export function isTradingDay(date: Date): boolean {
  return !isWeekend(date) && !isNyseHoliday(date);
}

/**
 * Return the NYSE market close time for the given date as a UTC Date.
 * Regular close: 16:00 ET. Early close: 13:00 ET.
 */
export function getMarketCloseTime(date: Date): Date {
  const hour = isEarlyClose(date) ? 13 : 16;
  const dateStr = toETDateString(date);
  // Interpret close time as a wall-clock time in ET, convert to UTC
  const wallClock = `${dateStr}T${String(hour).padStart(2, "0")}:00:00`;
  return fromZonedTime(wallClock, TZ);
}

/**
 * Return the most recent NYSE trading day strictly before `date`.
 * Walks backwards skipping weekends and holidays (max 10 steps to avoid infinite loop).
 */
export function getPrevTradingDay(date: Date): Date {
  const d = new Date(date);
  let steps = 0;
  do {
    d.setUTCDate(d.getUTCDate() - 1);
    steps++;
    if (steps > 10) throw new Error("getPrevTradingDay: could not find prior trading day in 10 steps");
  } while (!isTradingDay(d));
  return d;
}

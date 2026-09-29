/**
 * The length limits on what a person types, in one place (rackbops-bot-plugins#80): discord.ts sets
 * them as each slash option's `setMaxLength`, the web forms as each field's `maxlength`, and the
 * shared rules (reminders.ts, tracked.ts, price.ts) check them on the server, so a form post that
 * skips the browser meets the same limit a slash command does. A limit is on the trimmed text.
 */

/** A task's name, and a renewal's or a price's name option. */
export const MAX_TITLE = 100;
/** A reminder's text: it goes out as the DM itself. */
export const MAX_REMINDER_TEXT = 1500;
/** A `when` or an `until`: docket's parseWhen grammar is short. */
export const MAX_WHEN = 100;
/** A renewal's note, carried on every ask. */
export const MAX_NOTE = 300;
/** A price's page. */
export const MAX_URL = 1000;
/** A price's `near` text. */
export const MAX_NEAR = 100;
/** A currency code. */
export const CURRENCY_LENGTH = 3;
/** A `YYYY-MM-DD` date. */
export const DATE_LENGTH = 10;
/** An IANA time zone name. */
export const MAX_ZONE = 64;
/** A task id typed into a command. */
export const MAX_TASK_ID = 24;
/**
 * Active and paused tasks one person may own, of every type together: generous for a person, a
 * bound for a script. Price trackers have their own, lower cap (price.ts).
 */
export const MAX_LIVE_TASKS = 200;

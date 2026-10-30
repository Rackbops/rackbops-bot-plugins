/**
 * The limits on what a person types, in one place (rackbops-bot-plugins#80), and the cap on how many
 * tasks they keep (`MAX_LIVE_TASKS`, last, checked by actions.ts's `liveTaskCap`). The length
 * limits: discord.ts sets them as each slash option's `setMaxLength`, the web forms as each field's
 * `maxlength`, and the shared rules (reminders.ts, tracked.ts, price.ts, research.ts, want.ts),
 * `/task snooze`'s `until` (actions.ts) and the settings form (web/app.ts) check them on the server,
 * so a form post that skips the browser meets the same limit a slash command does. A length limit is
 * on the trimmed text.
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
/** A watch's exclude words, as one comma-separated field (want.ts reads at most docket's 20 entries). */
export const MAX_EXCLUDE_TEXT = 1000;
/** A watch's confirm and unconfirmed words, each one comma-separated field: shorter, so the want form stays under the body cap. */
export const MAX_CONFIRM_TEXT = 300;
/** A price's `near` text. */
export const MAX_NEAR = 100;
/**
 * The most a renewal's amount may be, as set by `/renewal`, `/task decide`, the web editor and the
 * Task API alike (tracked.ts's `amountProblem`): far above any subscription, low enough that the
 * amount still prints as a plain number (`1e21` would print as `1e+21 USD`). A default the owner
 * can change.
 */
export const MAX_AMOUNT = 1_000_000;
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

/** A reminder named "Alarm · 7:00 AM" (what vyrse_reminders calls an alarm) rings until it's stopped. */
export function isAlarm(name: string): boolean {
  return /^Alarm(?![A-Za-z0-9_])/.test(name);
}

/** The answer to a yes/no card that means no (plays the "deny" sound). */
export function isDecline(choice: string | null | undefined): boolean {
  return !choice || /^(?:cancel|not now|no|deny)(?![A-Za-z0-9_])/i.test(choice);
}

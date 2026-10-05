/**
 * How a Codex thread id is shortened for a log line, a notice or a label: its LAST eight
 * characters. A thread id is a UUIDv7, which begins with a millisecond timestamp, so two threads
 * created within about 65 seconds share their first eight characters (a live log read `rotated
 * from 01a106f2 to 01a106f2`, which looks like no rotation); the random part is at the end.
 *
 * Whole ids stay wherever they already are (resume commands, mismatch pointers). remi's own
 * session ids and Claude's are version 4 UUIDs, random throughout, and keep their first eight.
 */
export const shortThreadId = (id: string): string => id.slice(-8);

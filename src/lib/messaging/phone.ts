// Phone numbers. WhatsApp gives the sender as digits with the country code (2348012345678);
// people type them in all sorts of ways. Both end up as the same digits.

/** Digits only, in international form. null = this cannot be a phone number. */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2); // 00234...
  else if (/^0\d{10}$/.test(digits)) digits = `234${digits.slice(1)}`; // 0801 234 5678
  else if (/^2340\d{10}$/.test(digits)) digits = `234${digits.slice(4)}`; // +234 (0)801 234 5678
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** +2348012345678, the form stored in the users table. */
export const toE164 = (digits: string): string => `+${digits}`;

import type { ModalField } from "../config/events.js";

export type ValidationResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Phone numbers are stored as bare digits. A leading + and any spaces or
 * dashes are accepted from the participant and stripped before the value
 * reaches the sheet.
 */
function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

function validateField(
  field: ModalField,
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();

  if (!trimmed) {
    if (field.required) {
      return { ok: false, message: `**${field.label}** is required.` };
    }
    return { ok: true, value: "" };
  }

  switch (field.kind) {
    case "email": {
      const value = normaliseEmail(trimmed);

      if (!EMAIL_PATTERN.test(value)) {
        return {
          ok: false,
          message: `**${field.label}** must be a valid email address.`,
        };
      }

      return { ok: true, value };
    }

    case "phone": {
      const value = normalisePhone(trimmed);

      if (value.length < 10 || value.length > 15) {
        return {
          ok: false,
          message: `**${field.label}** must be a phone number of 10 to 15 digits.`,
        };
      }

      return { ok: true, value };
    }

    case "text": {
      const min = field.minLength ?? 1;
      const max = field.maxLength ?? 100;

      if (trimmed.length < min || trimmed.length > max) {
        return {
          ok: false,
          message: `**${field.label}** must be between ${min} and ${max} characters.`,
        };
      }

      return { ok: true, value: trimmed };
    }
  }
}

/**
 * Validates every field of a modal submission and returns the normalised
 * values, or the first problem it found.
 */
export function validateSubmission(
  fields: ModalField[],
  rawValues: Record<string, string>,
): ValidationResult {
  const values: Record<string, string> = {};

  for (const field of fields) {
    const result = validateField(field, rawValues[field.id] ?? "");

    if (!result.ok) return { ok: false, message: result.message };

    values[field.id] = result.value;
  }

  return { ok: true, values };
}

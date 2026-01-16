/**
 * Phone Number Validation Utility for Kenyan M-Pesa Numbers
 * Handles multiple input formats and normalizes to E.164 (254XXXXXXXXX)
 */

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

/**
 * Validates and normalizes a Kenyan phone number to E.164 format
 *
 * Accepts:
 * - 07XXXXXXXX (10 digits)
 * - 254XXXXXXXXX (12 digits)
 * - 7XXXXXXXX (9 digits)
 *
 * Returns normalized format: 254XXXXXXXXX
 *
 * @param phone - Phone number in any supported format
 * @returns Validation result with normalized number
 */
export function validateAndNormalizePhone(phone: string): PhoneValidationResult {
  // Remove spaces, dashes, plus signs
  const cleaned = phone.replace(/[\s\-\+]/g, '');

  // Check if only digits
  if (!/^\d+$/.test(cleaned)) {
    return {
      valid: false,
      normalized: '',
      error: 'Phone number must contain only digits'
    };
  }

  // Handle 07XXXXXXXX format (Kenyan local format)
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    const normalized = '254' + cleaned.substring(1);

    // Validate it's a valid Kenyan mobile number (starts with 7 or 1)
    if (!normalized.match(/^254[17]\d{8}$/)) {
      return {
        valid: false,
        normalized: '',
        error: 'Phone number must be a valid Kenyan mobile number (07XXXXXXXX or 01XXXXXXXX)'
      };
    }

    return { valid: true, normalized };
  }

  // Handle 254XXXXXXXXX format (E.164 format)
  if (cleaned.startsWith('254') && cleaned.length === 12) {
    // Validate it's a valid Kenyan mobile number
    if (!cleaned.match(/^254[17]\d{8}$/)) {
      return {
        valid: false,
        normalized: '',
        error: 'Phone number must be a valid Kenyan mobile number (254[7/1]XXXXXXXX)'
      };
    }

    return { valid: true, normalized: cleaned };
  }

  // Handle 7XXXXXXXX or 1XXXXXXXX format (missing country code and leading 0)
  if ((cleaned.startsWith('7') || cleaned.startsWith('1')) && cleaned.length === 9) {
    const normalized = '254' + cleaned;

    // Validate it's a valid Kenyan mobile number
    if (!normalized.match(/^254[17]\d{8}$/)) {
      return {
        valid: false,
        normalized: '',
        error: 'Invalid phone number format'
      };
    }

    return { valid: true, normalized };
  }

  // Invalid format
  return {
    valid: false,
    normalized: '',
    error: 'Phone number must be in format: 07XXXXXXXX, 254XXXXXXXXX, or 7XXXXXXXX'
  };
}

/**
 * Validates that a phone number is in the correct E.164 format
 * Use this after normalization to double-check
 *
 * @param phone - Phone number in E.164 format
 * @returns true if valid Kenyan mobile number
 */
export function isValidE164KenyanNumber(phone: string): boolean {
  return /^254[17]\d{8}$/.test(phone);
}

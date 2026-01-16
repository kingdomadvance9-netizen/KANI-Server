/**
 * Amount Validation Utility for M-Pesa Transactions
 * M-Pesa only accepts integer amounts (whole KES)
 */

export interface AmountValidationResult {
  valid: boolean;
  amount: number;
  error?: string;
}

/**
 * Validates that an amount is a valid integer >= 1 KES
 * M-Pesa does not support decimal amounts
 *
 * @param amount - Amount to validate (number or string)
 * @returns Validation result
 */
export function validateAmount(amount: number | string): AmountValidationResult {
  // Convert string to number if needed
  const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

  // Check if valid number
  if (isNaN(numAmount)) {
    return {
      valid: false,
      amount: 0,
      error: 'Amount must be a valid number'
    };
  }

  // Check if positive
  if (numAmount < 1) {
    return {
      valid: false,
      amount: numAmount,
      error: 'Amount must be at least 1 KES'
    };
  }

  // Check if integer (no decimals)
  if (!Number.isInteger(numAmount)) {
    return {
      valid: false,
      amount: numAmount,
      error: 'Amount must be a whole number (no decimals). M-Pesa only accepts integer amounts.'
    };
  }

  // Check reasonable upper limit (100,000 KES = ~$770 USD)
  // Safaricom has limits, typically 150,000 KES for transactions
  if (numAmount > 150000) {
    return {
      valid: false,
      amount: numAmount,
      error: 'Amount exceeds maximum limit of 150,000 KES'
    };
  }

  return {
    valid: true,
    amount: numAmount
  };
}

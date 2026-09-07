import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import Decimal from 'decimal.js';
import {
  DECIMAL_INTEGER_DIGITS,
  DECIMAL_SCALE,
  MAX_DECIMAL_ABS,
} from '../decimal';

/**
 * Validation for portfolio decimal request fields (quantity, average purchase
 * price).
 *
 * Request values are JSON numbers (within the documented double-safe range).
 * They must be finite numbers greater than zero with no more than
 * `DECIMAL_INTEGER_DIGITS` integer digits and no more than `DECIMAL_SCALE`
 * decimal places — exactly what `numeric(18,6)` can store. `null`, `NaN`,
 * `Infinity`, non-numeric types, zero, negatives, over-large magnitudes, and
 * more than six decimal places all reject.
 *
 * decimal.js is used for the bounds/decimal-count checks so that validation and
 * the valuation math that follows share one exact representation.
 */

function fixedDecimalValidator(optional: boolean): {
  validate(value: unknown): boolean;
  defaultMessage(args: ValidationArguments): string;
} {
  return {
    validate(value: unknown): boolean {
      // A truly absent optional field is skipped; nothing else is. `null` must
      // be validated (and rejected), never treated as "not provided".
      if (optional && value === undefined) {
        return true;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
      }
      const decimal = new Decimal(value);
      if (decimal.lte(0)) {
        return false;
      }
      if (decimal.abs().gte(MAX_DECIMAL_ABS)) {
        return false;
      }
      return decimal.decimalPlaces() <= DECIMAL_SCALE;
    },
    defaultMessage(args: ValidationArguments): string {
      const rule =
        `must be a finite number greater than 0 with at most ` +
        `${DECIMAL_INTEGER_DIGITS} integer digits and at most ` +
        `${DECIMAL_SCALE} decimal places`;
      return optional
        ? `${args.property}, when provided, ${rule}.`
        : `${args.property} ${rule}.`;
    },
  };
}

/** Required positive fixed-point decimal (create payloads). */
export function IsPositiveFixedDecimal(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: fixedDecimalValidator(false),
    });
  };
}

/**
 * Optional positive fixed-point decimal (patch payloads). Skips only `undefined`
 * (a truly absent field); `null` and every other invalid value still reject.
 */
export function IsOptionalPositiveFixedDecimal(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: fixedDecimalValidator(true),
    });
  };
}

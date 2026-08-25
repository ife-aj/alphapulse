import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class GetCandlesQueryDto {
  /**
   * How many trading days of history to return, e.g. ?days=90
   * When omitted, the controller falls back to a sensible default.
   */
  @IsOptional()
  @Type(() => Number) // query params arrive as strings; coerce before validating
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

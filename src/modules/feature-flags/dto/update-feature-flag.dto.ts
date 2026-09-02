import { PartialType } from '@nestjs/mapped-types';
import { CreateFeatureFlagDto } from './create-feature-flag.dto';

/**
 * All fields from CreateFeatureFlagDto become optional.
 * The `key` field is intentionally omitted — keys are immutable after creation.
 */
export class UpdateFeatureFlagDto extends PartialType(CreateFeatureFlagDto) {}

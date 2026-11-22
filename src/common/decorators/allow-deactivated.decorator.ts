import { SetMetadata } from '@nestjs/common';

export const ALLOW_DEACTIVATED_KEY = 'allowDeactivated';

/**
 * Lets a deactivated account through JwtAuthGuard on this route (used by the
 * reactivation endpoint). Every other route rejects deactivated accounts.
 */
export const AllowDeactivated = () => SetMetadata(ALLOW_DEACTIVATED_KEY, true);

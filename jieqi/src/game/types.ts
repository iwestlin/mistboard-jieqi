// Minimal slice of the upstream `@mistboard/game` types that the jieqi kernel
// needs. Kept here so this project has no workspace dependency.

export type AbortReason = 'pregame-timeout' | 'user-abort' | 'engine-unavailable';

/**
 * What a field shows for a saved key or secret. The backend never returns
 * saved keys, so the mask is a fixed-length stand-in.
 */
export const SAVED_KEY_MASK = "x".repeat(24);

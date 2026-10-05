/** Display units for external cameras. Shared by import validation and camera controls. */
export const EXTERNAL_CAMERA_LIMITS = {
  space: { minDistance: 2.1, maxDistance: 22 },
  globe: { minDistance: 1.8, maxDistance: 7 },
  horizon: { minDistance: 1.8, maxDistance: 7 },
} as const;

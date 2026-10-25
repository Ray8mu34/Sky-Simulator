export type OfflinePhase = 'portable' | 'development' | 'unsupported' | 'installing' | 'ready' | 'update-ready' | 'update-failed' | 'error';
/** One lifecycle owner in platform/offline; UI only presents this version-qualified status. */
export interface OfflineStatus {
  phase: OfflinePhase;
  message: string;
  expectedBuildId: string | null;
  activeBuildId: string | null;
  waitingBuildId: string | null;
  /** A completed update request is separate from an installation or cache probe. */
  updateCheck: 'idle' | 'checking' | 'current' | 'failed';
  lastCheckedAt: number | null;
  canCheckForUpdate: boolean;
}
export interface OfflineController {
  getStatus(): OfflineStatus;
  checkForUpdate(): Promise<void>;
  dispose(): void;
}

import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  autoMigrateLegacyState as autoMigrateLegacyStateWithSurfaces,
  detectLegacyStateMigrations as detectLegacyStateMigrationsWithSurfaces,
  runLegacyStateMigrations as runLegacyStateMigrationsWithSurfaces,
} from "./state-migrations.doctor.js";

type DetectLegacyStateParams = Parameters<typeof detectLegacyStateMigrationsWithSurfaces>[0];
type RunLegacyStateParams = Parameters<typeof runLegacyStateMigrationsWithSurfaces>[0];
export type AutoMigrateLegacyStateParams = Parameters<typeof autoMigrateLegacyStateWithSurfaces>[0];

type CoreMigrationParams<T> = Omit<T, "legacySessionSurfaces"> & {
  legacySessionSurfaces?: DetectLegacyStateParams["legacySessionSurfaces"];
};

// The broad core suites intentionally exercise migration mechanics without plugin-owned keys.
// Package-shaped coverage owns configured plugin resolution and setup-sidecar loading.
export function detectLegacyStateMigrations(params: CoreMigrationParams<DetectLegacyStateParams>) {
  return detectLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

export function runLegacyStateMigrations(params: CoreMigrationParams<RunLegacyStateParams>) {
  return runLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

export function autoMigrateLegacyState(params: CoreMigrationParams<AutoMigrateLegacyStateParams>) {
  return autoMigrateLegacyStateWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

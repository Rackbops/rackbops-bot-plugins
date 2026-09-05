# Changelog

## [0.0.2] - 2026-09-04

### Fixed

- Add `repository` so npm OIDC provenance verification passes (the `0.0.1` publish was
  rejected E422 for an empty `repository.url`). Throwaway.

## [0.0.1] - 2026-09-04

### Added

- CI/OIDC publish test: this version is published by `publish.yml` via GitHub Actions
  OIDC trusted publishing (no token), proving the pipeline end to end. Throwaway.

## [0.0.0] - 2026-09-04

### Added

- Placeholder release to bootstrap trusted publishing for `@rackbops/plugin-hello`
  (a package must exist before a Trusted Publisher can be attached). Throwaway.

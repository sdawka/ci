# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Fixed

- Sandbox runner step logs are always bounded strings. Each log returns at most
  its last 300,000 bytes with a truncation marker, so steps with large output no
  longer return unserializable streams, and symlinked logs are not followed.

## 0.2.0 - 2026-09-14

### Changed

- Sandbox runners now use RPC transport and automatically select the local R2
  backup path when `/dev/fuse` is unavailable, allowing backups and restores to
  work under `wrangler dev` without additional environment configuration.

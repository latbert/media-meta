# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-17

### Added

- `@nopilot/media-meta-engine`: EXIF + XMP reader for HEIC/HEIF/AVIF (ISOBMFF `meta` → `iinf`/`iloc` → Exif & mime items) and WebP (RIFF `EXIF`/`XMP ` chunks, with and without the TIFF-offset prefix). TIFF IFD walker with both endian-ness, IFD0/Exif/GPS groups, common value types (ASCII/short/long/rational/srational). Zero runtime dependencies.
- Programmatically generated minimal HEIC/HEIF/AVIF/WebP fixtures (`buildHeicFixture`, `buildAvifFixture`, `buildWebp`, `buildExifPayload`, ...) — test coverage never touches downloaded binaries or the network.
- `image_metadata_read` MCP tool via `@nopilot/media-meta-mcp` (stdio + stateless Streamable HTTP), built on the official MCP TypeScript SDK. Pure local byte parsing: zero network, zero LLM, no hosted gateway.
- Determinism harness: fixtures byte-reproducible, reads byte-stable (`scripts/determinism-check.mjs`).

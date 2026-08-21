# Agent Note: Keep web drag chrome Windows-only

Status: implemented

English | [中文](2026-08-17-windows-only-web-drag-chrome.zh.md)

## Problem

The Electron renderer's custom drag regions use `cursor: grab` and occupy fixed header rectangles. Installing them on macOS adds a hand-cursor hit area beside the native hidden-inset title bar, so moving across the header switches between the drag cursor and the document cursor.

## Decision

`shouldInstallWindowDragChrome()` returns true only for `win32`. The macOS window keeps its native hidden-inset title bar and receives neither the injected drag CSS nor the drag-region DOM. The Windows-only rule is pinned by `apps/desktop/tests/window-chrome.spec.ts`.

## Alternatives considered

**Install the same web drag regions on macOS.** Rejected: macOS already supplies the title-bar drag behavior, and the web regions add cursor and hit-testing state without providing a required capability.

**Remove custom drag chrome on every platform.** Rejected: the frameless Windows window needs renderer-owned drag regions and caption controls.

## Consequences

macOS keeps a stable document cursor outside native title-bar controls. Any future custom macOS title-bar implementation must replace the platform guard and update the regression test together.

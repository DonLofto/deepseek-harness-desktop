# Agent Note: 仅在 Windows 使用网页拖动窗口装饰

Status: implemented

[English](2026-08-17-windows-only-web-drag-chrome.md) | 中文

## 问题

Electron 渲染层的自定义拖动区域使用 `cursor: grab`，并占据固定的标题栏矩形区域。在 macOS 上安装这些区域会在原生 hidden-inset 标题栏旁增加手形光标命中区域，因此指针经过标题栏时会在拖动光标与文档光标之间切换。

## 决策

`shouldInstallWindowDragChrome()` 只对 `win32` 返回 true。macOS 窗口保留原生 hidden-inset 标题栏，不接收注入的拖动 CSS，也不接收拖动区域 DOM。Windows-only 规则由 `apps/desktop/tests/window-chrome.spec.ts` 固定。

## 备选方案

**在 macOS 安装相同的网页拖动区域。** 否决：macOS 已提供标题栏拖动行为，网页区域只会增加光标和命中测试状态，却不提供必要能力。

**在所有平台移除自定义拖动装饰。** 否决：无边框 Windows 窗口需要由渲染层拥有拖动区域与标题栏按钮。

## 影响

macOS 在原生标题栏控件之外保持稳定的文档光标。将来若实现自定义 macOS 标题栏，必须同时调整平台判断与回归测试。

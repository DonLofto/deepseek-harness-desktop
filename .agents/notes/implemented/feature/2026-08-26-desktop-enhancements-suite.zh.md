# Agent 记录：桌面端增强套件（模型价格显示、收藏置顶与 Markdown 会话导出）

状态：已实现

[English](2026-08-26-desktop-enhancements-suite.md) | 中文

## 问题

随着 DeepSeek Harness Desktop 支持更多模型以及复杂的长期对话流程，用户在日常使用中需要直观了解模型 token 价格、快速访问常用偏好模型，并将完整会话导出用于归档或共享：

1. **模型 Token 价格可见性**：OpenRouter 动态接口提供了每个 token 的 prompt 与 completion 价格，但此前网关在构建模型目录时丢弃了价格数据，用户无法快速识别免费模型或区分不同计费梯队。
2. **模型收藏与快速切换（Pinned / Favorites）**：在接入数百个模型时，每次切换都需重新搜索或向下滚动，操作繁琐。
3. **Markdown 会话导出**：用户需要一种便捷方式将当前会话历史（包括用户提问、思考过程以及助手回答）导出为标准 GitHub 风格的 Markdown 文档。

## 决策

我们在底层适配器、网关协议与前端 UI 层面实现了桌面端增强套件：

- **模型价格与成本标签**：
  - `packages/llm/llm-pi-ai/src/openrouter.ts`：解析 OpenRouter 的 `pricing: { prompt, completion }`，转换为每百万 token（$/1M）的 `ModelCost`。
  - `packages/llm/llm/src/types.ts` 与 `src/index.ts`：在 `LlmResolvedModelInfo` 中透传 `cost?: { input?: number; output?: number }`。
  - `packages/host/apiproxy/src/api/sessions.ts` 与 `sessions.schema.ts`：在 `ModelCatalogModel` 及其 Zod 校验模式中补充 `pricing` 字段，并在 `api-proxy.ts` 中映射。
  - `packages/client/ui-model-selection/src/client/format.ts`：实现 `formatModelPricing(pricing)` 格式化逻辑（`Free`、`<$0.01/1M`、`$0.15/1M`、`$3/1M`）。
  - `packages/client/ui-model-selection/src/client/ModelSelect.tsx`：在上下文标签旁渲染 `.pricingBadge`，并在 `/model` 弹窗的搜索关键词中索引价格。

- **收藏/置顶模型快捷切换（Pinned Models）**：
  - `packages/client/ui-model-selection/src/client/pins.ts`：通过 `localStorage` 的 `dsh.pinnedModels` 持久化用户星标模型。
  - `packages/client/ui-model-selection/src/client/ModelSelect.tsx`：在各模型项提供星标操作按钮，并在列表最上方动态插入 `⭐ Pinned` 分组。

- **一键会话导出为 Markdown**：
  - `packages/client/ui-conversation/src/client/export/markdown.ts`：将 `ConversationSnapshot` 中的节点转换为包含会话元信息、用户提示、思考引用块（`> **Thinking:**`）和助手回答的结构化 Markdown，并提供浏览器下载工具函数。

## 替代方案

**每次请求时单独查询模型价格而非通过模型目录传递**：会增加不必要的 RPC 往返延迟并降低选择器响应速度；将可选价格字段纳入模型目录可保持元数据的原子性与缓存一致性。

**仅在内存中维护置顶状态而不进行 localStorage 持久化**：用户刷新页面或新建标签页后置顶状态将丢失。

**仅导出原始 JSON 日志而非格式化的 Markdown**：JSON 日志便于程序回放但不适合人类阅读与分享；标准 Markdown 提供了开箱即用的优质阅读与文档共享体验。

## 后果

- 用户在模型选择器和 `/model` 弹窗中可直观查看价格标签（`Free` 或 `$X/1M`）。
- 常用模型可加星置顶，实现一键切换。
- 会话内容可一键导出为标准的 Markdown 文档。

## 测试

- `packages/llm/llm-pi-ai/tests/openrouter.spec.ts` 验证价格解析与成本换算。
- `packages/host/apiproxy/tests/api-proxy-models.spec.ts` 验证协议序列化。
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` 验证价格标签与星标置顶交互。
- `packages/client/ui-conversation/tests/export-markdown.client.spec.tsx` 验证 Markdown 格式化输出。
- 全量 TypeScript 类型检查及各模块 1,112 项 Vitest 单元测试全部通过。

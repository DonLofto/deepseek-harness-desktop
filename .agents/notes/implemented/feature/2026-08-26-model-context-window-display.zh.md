# Agent 记录：模型上下文窗口发现、协议传递与 UI 展示

状态：已实现

[English](2026-08-26-model-context-window-display.md) | 中文

## 问题

DeepSeek、OpenRouter 及自定义网关等提供商发布的模型具有不同的上下文窗口上限（如 128K、200K、1M tokens）和最大输出限制。此前，尽管 `@deepseek-ai/dsh-llm` 适配器能解析出 `LlmResolvedModelInfo.context.contextWindow` 和 `defaultMaxTokens`，但 API 代理（`packages/host/apiproxy`）在为 `session.models` 和 `llm.models` 构造 `ModelProviderGroup.models` 条目时丢弃了这些容量信息。因此，客户端界面（输入框模型选择器和 `/model` 弹出菜单）无法感知上下文容量，用户也无法根据上下文大小查看或搜索模型。

## 决策

我们在通信协议、API 代理及客户端选择界面中全链路暴露并展示模型上下文窗口容量：

- **API 代理协议定义（`packages/host/apiproxy`）**：
  - 在 `sessions.ts` 和 `sessions.schema.ts` 中的 `ModelCatalogModel` 及 `modelCatalogModelSchema` 添加可选的 `contextWindow` 与 `maxTokens` 字段。
  - 更新 `api-proxy.ts` 中的 `buildModelCatalog`，从解析的模型元数据中提取 `resolved.context?.contextWindow` 与 `resolved.defaultMaxTokens` 并传递给模型目录条目。

- **Token 容量格式化工具（`packages/client/ui-model-selection/src/client/format.ts`）**：
  - 实现 `formatTokenCapacity(tokens)`，将 token 数值格式化为清晰的人类可读标签（`1048576` -> `1M`、`200000` -> `200K`、`131072` -> `128K`、`65536` -> `64K`、`32768` -> `32K`、`8192` -> `8K`、`4096` -> `4K`）。

- **输入框模型席位（`packages/client/ui-model-selection/src/client/ModelSelect.tsx`）**：
  - 当模型包含 `model.contextWindow` 时，在下拉项的模型名称旁渲染 `.contextBadge` 徽章，并在 `ModelSelect.module.css` 中使用 `--dsw-*` token 进行样式设计。

- **命令弹窗过滤（`packages/client/ui-model-selection/src/client/index.ts`）**：
  - 在 `/model` 弹窗选项详情中包含格式化后的上下文容量（例如 `DeepSeek · deepseek-v4-flash · 128K ctx`），支持按上下文大小进行实时模糊搜索。

## 备选方案

**在模型目录 RPC 中省略上下文窗口，改为单模型逐个查询**：会增加客户端往返开销并让列表渲染复杂化；在 `ModelCatalogModel` 中包含可选容量保持了目录解析的原子性。

**直接展示原始 token 数字而不进行格式化**：未格式化的数字（如 `1048576`）不易一眼识别；标准的 `K`/`M` 格式符合开发人员习惯。

## 后果

- 用户可以在模型选择器中直接查看各个模型的上下文容量。
- 用户可以在 `/model` 中输入诸如 `1M` 或 `128k` 等上下文大小进行过滤。
- 通信协议通过可选数字容量保持向后兼容。

## 测试

- `packages/host/apiproxy/tests/api-proxy-models.spec.ts` 中的单元测试验证 `session.models` 响应中正确提取并序列化 `contextWindow` 与 `maxTokens`。
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` 中的单元测试验证包含 `contextWindow` 的模型能正常渲染上下文徽章。
- `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` 中的单元测试验证 `/model` 选项详情中包含格式化后的上下文窗口标签。

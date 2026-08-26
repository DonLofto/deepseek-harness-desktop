# Agent Note: OpenRouter 实时模型发现、元数据映射与选择器搜索

Status: implemented

[English](2026-08-26-openrouter-live-model-discovery.md) | 中文

## Problem

OpenRouter 频繁上线新的 LLM 模型、变体及定价层级，超出任何静态打包的模型目录。此前，`@deepseek-ai/dsh-llm-pi-ai` 仅能通过静态目录描述符或手工显式声明的 `models` 数组解析 OpenRouter。在配置了 OpenRouter API 密钥的情况下，用户只能使用构建时打包的静态模型快照，除非手动在 `settings.yaml` 中逐个声明模型 ID 与容量。

此外，输入框模型插槽（`ModelSelect.tsx`）与 `/model` 弹出选择器缺少对已加载模型的实时搜索过滤功能，在数百个可用模型中导航较为繁琐。设置界面中的“获取可用模型”对话框也缺少对大量候选模型的过滤搜索。

## Decision

我们在适配器、宿主以及客户端 UI 各层为 OpenRouter 引入了自动实时模型发现、缓存与能力映射：

- **动态目录获取器 (`packages/llm/llm-pi-ai/src/openrouter.ts`)**：
  - 使用配置的 OpenRouter API 密钥及标准 DeepSeek Harness 归属请求头（`HTTP-Referer`、`X-Title` 和 `User-Agent`）自动请求 `GET https://openrouter.ai/api/v1/models`。
  - 将 OpenRouter 模型元数据映射为 pi-ai `Model<Api>` 描述符：
    - `id` -> `Model.id`
    - `name` -> `Model.name`
    - `context_length` -> `contextWindow`
    - `top_provider.max_completion_tokens` / `max_output_tokens` / `max_tokens` -> `maxTokens`
    - `architecture.modality` 与 `input` -> `['text']` 或 `['text', 'image']`
    - `supported_parameters`（检测 `reasoning` 或 `include_reasoning`）-> 启用 `reasoning: true` 并附加标准 `ThinkingLevelMap`。
  - 将发现的模型保存在内存中，默认具备可配置的 1 小时 TTL 缓存（`openrouterCatalogTtlMs`）。
  - 在离线或网络故障时优雅回退到内置的静态模型目录。
  - 将用户自定义的 `presets` 和 `modelOverrides` 叠加在实时模型之上，保留自定义配置。
  - 将活跃模型注册到提供方路由中，使 `getModels()` 和模型解析能够动态识别所有实时模型。

- **设置发现钩子 (`packages/llm/llm-pi-ai/src/discovery.ts`)**：
  - 在设置界面触发“获取可用模型”时，`discoverModels()` 查询实时 OpenRouter 端点而非直接返回静态模型。

- **输入框与命令模型选择器搜索 (`packages/client/ui-model-selection`)**：
  - `ModelSelect.tsx`：在 `pane === 'model'` 顶部添加实时搜索输入框，打开时自动聚焦，支持键盘导航（`ArrowDown`、`Enter`、`Escape`），支持按名称、ID 和描述进行过滤，并提供搜索无结果的回退提示。
  - `index.ts` 中的 `optionsOf`：在 `detail` 中包含 `${group.name} · ${model.id}`，使 `/model` 弹出选择器的模糊搜索能够将模型 ID 与名称、描述一同索引。

- **设置候选模型搜索 (`packages/client/ui-settings-models`)**：
  - `ModelListEditor.tsx`：在“获取可用模型”采纳对话框中添加候选模型过滤及针对过滤项的全选/取消全选操作。

## Alternatives considered

**要求对每个未打包的模型进行手动录入。** 虽然保留了静态不可变性，但加重了用户跟踪上游模型发布和手工键入 JSON 配置的负担。

**进行无缓冲的后台轮询。** 定期轮询浪费带宽且增加了生命周期复杂性；在活动会话目录请求期间进行内存 TTL 缓存能够在有限的网络开销下获得最新的模型列表。

## Consequences

- OpenRouter 用户无需等待 Harness 发布即可立即使用上游新模型。
- 即使有数百个模型，导航依然快速且支持键盘操作。
- 离线环境下通过静态目录回退保持完全可用。

## Testing

- `packages/llm/llm-pi-ai/tests/openrouter.spec.ts` 中的单元测试验证模型元数据映射、推理能力提取、实时获取、TTL 缓存、回退、预设叠加以及发现集成。
- `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` 与 `browser-plugin.client.spec.ts` 验证实时搜索过滤、键盘导航以及 `/model` 弹出选择器索引。
- `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` 验证设置模态框中的候选模型搜索过滤与采纳选择。

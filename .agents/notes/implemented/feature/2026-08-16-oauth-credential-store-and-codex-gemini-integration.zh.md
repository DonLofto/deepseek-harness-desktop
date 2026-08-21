# Agent Note：OAuth 凭据存储与 ChatGPT/Codex 及 Google Gemini/ADC 集成

状态：已实现 (implemented)

[English](2026-08-16-oauth-credential-store-and-codex-gemini-integration.md) | 中文

## 问题

依赖订阅的模型路由（特别是面向 ChatGPT Plus/Pro/Team 订阅者的 `openai-codex` 以及使用 Google Cloud 应用默认凭据 ADC 的 `google-vertex`）通过 OAuth token 或环境发现进行鉴权，而非静态 API key。此前，`dsh-llm-pi-ai` 仅以临时的 `InMemoryCredentialStore` 构造 `createModels()`，缺少持久化 token 存储机制，导致 `openai-codex` 曾被从可配置提供方目录中隐藏以避免请求失败。拥有 ChatGPT 订阅或 Google Cloud 账户的用户无法直接使用现有账户运行推理。

## 决策

我们引入了基于文件的持久化 OAuth 凭据存储库，将其接入凭据能力 seam，并恢复了 `dsh-llm-pi-ai` 中支持 OAuth 的 catalog 提供方目录发现：

1. **`OAuthFileCredentialStore` (`dsh-credentials-local`):**
   - 实现 `@earendil-works/pi-ai` 的 `CredentialStore` 接口（`read`、`modify`、`delete`、`list`）。
   - 在跨进程写锁保护下，将凭据持久化到 `$DSH_HOME/.credentials.oauth.json`，并强制执行严格的 `0600` POSIX 所有者专有权限。
   - 在需要时安全地按需自动创建与同步文档。

2. **凭据 Seam 扩展 (`dsh-credentials`):**
   - `CredentialProvider` 暴露可选的 `oauthStore?: OAuthCredentialStoreLike` 接口。
   - `LocalCredentialProvider` 在启动时实例化并挂载 `OAuthFileCredentialStore`。

3. **`dsh-llm-pi-ai` 集成:**
   - `PiAiAdapter` 将 `credentialStore` 传入 `createModels({ credentialStore })`，启用 pi-ai 原生的提供方 OAuth token 解析、自动刷新与请求标头生成。
   - `catalogProviderSupportsAuth(provider)` 检查 `auth.apiKey` 或 `auth.oauth`，在可配置提供方目录中重新开放 `openai-codex` 等支持 OAuth 的路由。

## 替代方案

- **仅使用内存存储 token：** 被拒绝。因为应用重启或配置快照重载时 token 会丢失，需要重复登录。
- **将 OAuth token 存放在 `.credentials.yaml` 中：** 被拒绝。`.credentials.yaml` 是静态密钥引用（`CredentialRef`）的严格字符串映射，而 OAuth token 包含结构化元数据（`token`、`refreshToken`、`expiresAt`、`accountId`）。
- **独立的外部代理守护进程：** 作为可选方案保留，但对于桌面端用户而言，原生凭据存储的使用体验更为一致。

## 影响

- `openai-codex`、`google-vertex`、`anthropic`、`openai` 等支持 OAuth 的提供方完整展示且可配置。
- 存储在 `$DSH_HOME/.credentials.oauth.json` 中的 OAuth 凭据会在模型流式请求期间由 pi-ai 自动使用并刷新。
- API key 路由保持完全向后兼容，继续通过 `ctx.credentials` 或环境变量解析。

## 测试

- `packages/credentials/credentials-local/tests/oauth-store.spec.ts` 单元测试验证原子读写、删除以及 `0600` 权限模式约束。
- `packages/llm/llm-pi-ai/tests/catalog.spec.ts` 集成测试验证 OAuth 路由在可配置提供方目录中的展示。
- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` 集成测试验证使用 `credentialStore` 存储的凭据执行流式请求。

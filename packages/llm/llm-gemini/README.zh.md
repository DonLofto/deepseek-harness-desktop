# @deepseek-ai/dsh-llm-gemini

[English](README.md) | 中文

DeepSeek Harness LLM 层的 Google Gemini 订阅与 Cloud Code PA LLM 提供商插件。

该插件支持通过 Google OAuth 2.0 设备代码流进行身份验证，查询 Google Cloud Code PA (`https://daily-cloudcode-pa.googleapis.com`) 获取订阅级别、配套项目和配额摘要，并通过 Gemini API (`https://generativelanguage.googleapis.com`) 流式传输推理轮次，并具备基于权限的 HTTP 402/426 配额处理。

本包导出了 Cordis 插件入口点、Google OAuth 令牌管理、Cloud Code PA 客户端和 Gemini 流式适配器。

## 配置

```yaml
- id: llm-gemini
  name: '@deepseek-ai/dsh-llm-gemini'
  config:
    cloudCodeEndpoint: https://daily-cloudcode-pa.googleapis.com # optional Cloud Code PA base URL
    apiServerUrl: https://generativelanguage.googleapis.com      # optional Gemini API server URL
    subclientType: hub                                           # optional client type identifier
    ideName: antigravity                                         # optional IDE client name
```

插件在 `ctx.llm` 上注册提供商路由 `google-gemini`。

## 模型体验

### Gemini 请求

#### 模型所见

选定的 Gemini 模型接收框架系统提示词、消息历史、工具定义和生成配置，转换为 Gemini Content 和 GenerateContentRequest 负载，不包含适配器编写的提示词散文。

#### Token 影响

提供商分词控制确切输入。生成的 Token 遵循请求的 maxTokens 设置和模型上下文边界。

#### KV 缓存影响

在 Gemini 端点支持的情况下，会话内的连续轮次符合提供商上下文缓存的条件。

### Gemini 响应

#### 模型所见

文本候选、推理思考块和函数调用调用被转换为框架 `StreamChunk` 事件，供循环记录和组装。

#### Token 影响

使用情况元数据在 `usage` 块中捕获，配额消耗根据订阅层级限制进行核对。

#### KV 缓存影响

响应 Token 会填充下游对话上下文以供后续轮次使用。

## 已知局限与延期工作

- 交互式设备代码 OAuth 登录需要桌面浏览器交互。

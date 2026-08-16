# OpenRouter Web Search Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship OpenRouter as the default `ctx.web` search provider while retaining the DeepSeek search provider as an explicit opt-in.

**Architecture:** Add a provider-private OpenRouter Chat Completions adapter that registers `openrouter` on `ctx.web`, resolves `OPENROUTER_API_KEY` per operation, maps `url_citation` annotations, and records a secret-free session event. Update the base composition, Host settings allowlist, browser settings card, package documentation, and generated catalogs together; keep `web_search` and the `ctx.web` service unchanged.

**Tech Stack:** TypeScript ESM workspace packages, Cordis namespace plugins, Schemastery, native `fetch`, Vitest, React client settings card, YAML bundle patches, repository documentation generators.

## Global Constraints

- Keep `@deepseek-ai/dsh-web-search-deepseek` available but out of the shipped default composition.
- Do not call `ctx.llm`; OpenRouter wire ownership stays inside the provider package.
- Credential-bearing HTTP requests use `redirect: 'error'` and never record or expose the API key.
- Resolve the configured credential on every search and snapshot all provider options once per operation.
- A successful response without a `url_citation` annotation is `WEB_PROVIDER_ERROR`.
- Caller cancellation during credential resolution, fetch, or response parsing is `WEB_ABORTED`.
- Preserve unrelated working-tree changes and do not edit generated English catalogs by hand.
- Every new package has a namespace export, package invariant companion, README pair, and package-level tests.

### Task 1: Add the OpenRouter provider package

**Files:**
- Create: `packages/web/web-search-openrouter/package.json`
- Create: `packages/web/web-search-openrouter/tsconfig.json`
- Create: `packages/web/web-search-openrouter/src/types.ts`
- Create: `packages/web/web-search-openrouter/src/provider.ts`
- Create: `packages/web/web-search-openrouter/src/index.ts`
- Create: `packages/web/web-search-openrouter/src/invariant.ts`
- Create: `packages/web/web-search-openrouter/tests/openrouter.spec.ts`
- Create: `packages/web/web-search-openrouter/tests/openrouter.e2e.ts`

**Interfaces:**
- Consumes: `WebSearchProvider`, `WebSearchRequest`, `WebSearchResult`, `WebError`, credential/environment/settings/agent/session services, and the existing `ctx.web` registration seam.
- Produces: `OpenRouterSearchProvider`, `OpenRouterSearchProviderOptions`, `OpenRouterSearchLlmRequest`, `mapOpenRouterResponse`, `OPENROUTER_PROVIDER_ID`, and namespace exports `name`, `inject`, `Config`, and `apply`.

- [ ] **Step 1: Write failing provider tests.** Cover annotation mapping with first-seen URL deduplication, optional title/snippet fields, prose content, no-citation rejection, request body/header/logging order, absent `maxResults`, explicit `maxResults`, availability, credential resolution and rotation, missing credentials, HTTP/provider/malformed-body errors, redirect rejection, cancellation at each async phase, HMR disposal, Loader namespace unwrapping, and invalid config.
- [ ] **Step 2: Run the focused suite and verify it fails because the package and provider exports do not exist.**
- [ ] **Step 3: Implement provider-private OpenRouter wire types and response mapping.** Read the first assistant message, require a `url_citation` annotation, map `url`, optional `title`, and annotation `content` to `snippet`, dedupe URLs in encounter order, and omit `publishedAt`.
- [ ] **Step 4: Implement the provider operation.** Build `POST ${baseURL}/chat/completions` with `model`, the exact user instruction, `openrouter:web_search`, `engine: auto`, configured `max_uses`, and request-level result caps copied to both count fields. Use bearer auth, JSON headers, `redirect: 'error'`, the caller signal, per-call credential resolution, pre-dispatch event recording, and the existing `WebError` codes.
- [ ] **Step 5: Implement namespace configuration and registration.** Use defaults `OPENROUTER_API_KEY`, `https://openrouter.ai/api/v1`, `openrouter/auto`, and `5`; mark `apiKey` secret and `apiKeyEnv` credential-ref; validate positive integer `maxUses`; project settings per search; use the credentials service with launch-environment fallback; register exactly one provider and retain HMR disposal.
- [ ] **Step 6: Run the focused suite and verify it passes.**
- [ ] **Step 7: Add the key-gated real-API test.** Skip without `OPENROUTER_API_KEY`, run one live search otherwise, and assert at least one normalized URL citation without pinning provider wording.

### Task 2: Switch the shipped bundle and document the provider boundary

**Files:**
- Modify: `packages/bundle/base/package.json`
- Modify: `packages/bundle/base/cordis.patch.yml`
- Modify: `packages/web/README.md`
- Modify: `packages/web/README.zh.md`
- Modify: `packages/web/web-search-deepseek/README.md`
- Modify: `packages/web/web-search-deepseek/README.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-16-openrouter-web-search-provider.md`
- Create: `.agents/notes/implemented/feature/2026-08-16-openrouter-web-search-provider.zh.md`

**Interfaces:**
- Consumes: the new package and the existing bundle row ids.
- Produces: a default composition with `searchProvider: openrouter` and only `web-search-openrouter`, plus an explicit DeepSeek patch example.

- [ ] **Step 1: Add a bundle/composition test that fails against the current DeepSeek default.** Assert the default `web` row selects `openrouter`, the default plugin list contains `web-search-openrouter`, and `web-search-deepseek` is absent.
- [ ] **Step 2: Run the focused bundle/composition test and verify the expected failure.**
- [ ] **Step 3: Replace the base bundle dependency and rows.** Mount only the OpenRouter provider with `apiKeyEnv: OPENROUTER_API_KEY`, preserve the existing `web_search` tool and timeout, and add the explicit patch instructions for mounting DeepSeek and selecting `deepseek-official`.
- [ ] **Step 4: Update package-family and provider README content.** Document OpenRouter configuration, citation mapping, errors, model/token/KV effects, credential storage, current server-tool semantics, and the opt-in DeepSeek patch in both languages.
- [ ] **Step 5: Write the implemented Agent Note pair.** Record the default-provider rationale, the independent auxiliary request, the opt-in boundary, and the tests that prove selection and citation invariants.
- [ ] **Step 6: Run the focused bundle/composition test and verify it passes.**

### Task 3: Retarget Host and browser settings surfaces

**Files:**
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/README.md`
- Modify: `packages/host/apiproxy/README.zh.md`
- Modify: `packages/host/apiproxy/tests/api-proxy-config.spec.ts`
- Modify: `packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts`
- Modify: `packages/client/ui-settings-plugins/src/client/WebSearchCard.tsx`
- Modify: `packages/client/ui-settings-plugins/src/client/locales.ts`
- Modify: `packages/client/ui-settings-plugins/tests/stores.client.spec.ts`
- Modify: `packages/client/ui-settings-plugins/tests/section.client.spec.tsx`

**Interfaces:**
- Consumes: namespace `web-search-openrouter`, `Config` fields `baseURL`, `model`, and `maxUses`, and the existing credential RPC.
- Produces: a settings card that edits the OpenRouter endpoint/model/search budget and writes the API key only through credentials RPC.

- [ ] **Step 1: Add failing Host and client tests for the new namespace and model field.** Assert only `web-search-openrouter` is exposed, the card labels OpenRouter, the model is staged/saved/reset, and credential operations address `OPENROUTER_API_KEY`.
- [ ] **Step 2: Run the focused Host/client suites and verify the expected failures.**
- [ ] **Step 3: Retarget the Host allowlist and explanatory docs.**
- [ ] **Step 4: Retarget the controller/card namespace and add the model field while preserving staged writes, secret redaction, credential invalidations, and read-only behavior.
- [ ] **Step 5: Update English/Chinese card copy and tests.**
- [ ] **Step 6: Run the focused Host/client suites and verify they pass.**

### Task 4: Regenerate catalogs and run repository verification

**Files:**
- Generated by `pnpm run doc-sync`: configuration, module, persistence, composition, and related catalog files that reference the shipped provider.
- Inspect only: `git diff --check` and all changed generated files.

**Interfaces:**
- Consumes: source package manifests, JSDoc, bundle patch, session event declaration, and README metadata.
- Produces: fresh generated documentation and a verified source/artifact plane.

- [ ] **Step 1: Run `pnpm run doc-sync` and review every generated change.**
- [ ] **Step 2: Run the focused provider, bundle, Host, and client Vitest suites.**
- [ ] **Step 3: Run `pnpm run typecheck` and `pnpm run build`.**
- [ ] **Step 4: Run relevant hygiene gates for package invariants, config/catalog freshness, README limitations, translations, and `git diff --check`.**
- [ ] **Step 5: Inspect `git status --short`, the complete scoped diff, and the test output; report unrelated pre-existing changes separately.

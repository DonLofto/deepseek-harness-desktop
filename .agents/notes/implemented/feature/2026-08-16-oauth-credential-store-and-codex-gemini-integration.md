# Agent Note: OAuth Credential Store & ChatGPT/Codex and Google Gemini/ADC Integration

Status: implemented

English | [中文](2026-08-16-oauth-credential-store-and-codex-gemini-integration.zh.md)

## Problem

Subscription-backed model routes — specifically `openai-codex` for ChatGPT Plus/Pro/Team subscribers and `google-vertex` using Google Cloud Application Default Credentials (ADC) — authenticate through OAuth tokens or ambient credential discovery rather than static API keys. Previously, `dsh-llm-pi-ai` constructed `createModels()` with an ephemeral `InMemoryCredentialStore` and lacked a persistent token storage mechanism, which led to `openai-codex` being withheld from the configurable-provider directory to prevent failed turns. Users with ChatGPT subscriptions or Google Cloud accounts could not use their existing accounts to run inference without paying for metered API credits.

## Decision

We introduce a file-backed OAuth credential vault, connect it through the credential capability seam, and restore OAuth-enabled catalog provider discovery across `dsh-llm-pi-ai`:

1. **`OAuthFileCredentialStore` (`dsh-credentials-local`):**
   - Implements `@earendil-works/pi-ai`'s `CredentialStore` interface (`read`, `modify`, `delete`, `list`).
   - Persists credentials in `$DSH_HOME/.credentials.oauth.json` under atomic cross-process file locks with strict `0600` owner-only POSIX permissions.
   - Reconciles and auto-creates the document securely on demand.

2. **Credential Seam Extension (`dsh-credentials`):**
   - `CredentialProvider` exposes the optional `oauthStore?: OAuthCredentialStoreLike` interface.
   - `LocalCredentialProvider` instantiates and attaches `OAuthFileCredentialStore` at boot.

3. **`dsh-llm-pi-ai` Integration:**
   - `PiAiAdapter` passes `credentialStore` into `createModels({ credentialStore })`, enabling pi-ai's native provider OAuth token resolution, automatic token refresh, and request header generation.
   - `catalogProviderSupportsAuth(provider)` checks for either `auth.apiKey` or `auth.oauth`, unwithholding `openai-codex` and other OAuth-capable catalog routes in the configurable provider directory.

## Alternatives considered

- **In-memory only tokens:** Rejected because tokens would be discarded on each app restart or configuration snapshot reload, requiring repeated re-authentication.
- **Storing OAuth tokens inside `.credentials.yaml`:** Rejected because `.credentials.yaml` is a strict string-to-string mapping for static secret references (`CredentialRef`), whereas OAuth tokens include structured metadata (`token`, `refreshToken`, `expiresAt`, `accountId`).
- **Separate external proxy daemon:** Valid as an optional deployment option, but adds process management overhead for desktop users compared to a native credential store.

## Consequences

- `openai-codex`, `google-vertex`, `anthropic`, `openai`, and other OAuth-enabled providers are fully offered and configurable.
- Stored OAuth credentials in `$DSH_HOME/.credentials.oauth.json` are automatically used and refreshed by pi-ai during model streaming requests.
- API key routes remain completely backward-compatible and continue to resolve through `ctx.credentials` or environment references.

## Testing

- Unit tests in `packages/credentials/credentials-local/tests/oauth-store.spec.ts` verify atomic reads, writes, deletions, and `0600` mode enforcement.
- Integration tests in `packages/llm/llm-pi-ai/tests/catalog.spec.ts` verify configurable provider listing for OAuth routes.
- Integration tests in `packages/llm/llm-pi-ai/tests/adapter.spec.ts` verify stream execution using stored credentials from `credentialStore`.

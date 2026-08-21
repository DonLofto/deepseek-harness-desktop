import { catalogProvider } from '../packages/llm/llm-pi-ai/src/catalog.ts'
import { OAuthFileCredentialStore } from '../packages/credentials/credentials-local/src/oauth-store.ts'
import { exec } from 'node:child_process'

const provider = process.argv[2] || 'openai-codex'

console.log(`Starting OAuth login for provider: ${provider}...`)
const p = catalogProvider(provider)
if (!p?.auth?.oauth) {
  console.error(`Provider "${provider}" does not support OAuth.`)
  process.exit(1)
}

const store = new OAuthFileCredentialStore()
const keepAlive = setInterval(() => {}, 5000)

const interaction = {
  prompt: async (req) => {
    if (req.type === 'select') return 'device_code'
    return ''
  },
  notify: (event) => {
    if (event.type === 'device_code') {
      console.log('\n================================================================')
      console.log('🔗 OpenAI Device Code Authentication')
      console.log('1. Go to URL:  ', event.verificationUri)
      console.log('2. Enter Code: ', event.userCode)
      console.log('================================================================\n')
      exec(`open "${event.verificationUri}"`)
    }
  },
}

try {
  const creds = await p.auth.oauth.login(interaction)
  await store.modify(provider, () => creds)
  clearInterval(keepAlive)
  console.log(`\n🎉 SUCCESS: Successfully authenticated and saved OAuth credentials for "${provider}" to ~/.dsh/.credentials.oauth.json!\n`)
  process.exit(0)
} catch (err) {
  clearInterval(keepAlive)
  console.error('\n❌ Login failed:', err.message || err)
  process.exit(1)
}

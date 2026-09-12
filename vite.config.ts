import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sites } from '@openai/sites-vite-plugin'
import hostingConfig from './.openai/hosting.json' with { type: 'json' }

const PLACEHOLDER_DATABASE_ID = '00000000-0000-4000-8000-000000000000'

export default defineConfig(async () => {
  if (process.env.SITES_BUILD !== '1') {
    return {
      plugins: [react()],
      server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
    }
  }

  process.env.WRANGLER_WRITE_LOGS ??= 'false'
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs'
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry'
  const { cloudflare } = await import('@cloudflare/vite-plugin')
  const { d1, r2 } = hostingConfig

  return {
    plugins: [
      react(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'server' },
        config: {
          name: 'dhara-land-records',
          main: './worker/index.ts',
          compatibility_date: '2026-05-22',
          compatibility_flags: ['nodejs_compat'],
          d1_databases: d1 ? [{ binding: d1, database_name: 'dhara-records', database_id: PLACEHOLDER_DATABASE_ID }] : [],
          r2_buckets: r2 ? [{ binding: r2, bucket_name: 'dhara-documents' }] : [],
          assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
        },
      }),
    ],
  }
})

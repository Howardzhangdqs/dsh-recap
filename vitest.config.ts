/**
 * Vitest config for dsh-recap. The specs are pure-node unit tests over the
 * host half's core seams (capture folding, store round-trip, generator
 * framing, queue seriality) with structural doubles for the cordis context,
 * plus the client specs (settings section, slot registrations) rendered
 * through React's server renderer.
 *
 * Inline the npm-published `@deepseek-ai/*` packages whose BUILT lib bundles
 * css side-effect imports (`dsh-client-ui-primitives` imports
 * `katex/dist/katex.min.css` at the top of its `lib/index.js`): installed
 * from the registry these packages live under `node_modules/.pnpm` and are
 * externalized by vitest — Node then chokes on the `.css` import. Inlining
 * routes them through Vite's transform, which stubs css imports (the default
 * `css: false`). The same workaround dsh-dashboard ships.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})

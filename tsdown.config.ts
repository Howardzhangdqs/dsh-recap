/**
 * tsdown build for dsh-recap: the host-half lib (lib/index.js and the
 * lib/invariant.js companion, ESM node) plus the two browser client bundles
 * (lib/client.js and lib/client-registry.js, CJS closure factory) — one per
 * install channel (the same split dsh-dashboard ships):
 *
 * - `lib/client.js` serves the official profile channel, registering with
 *   the package-name id `dsh-recap` (the client-modules compose keys on the
 *   package name; keep it in sync with package.json `name`),
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id `dsh-external/dsh-recap`
 *   (the registry browser-side `arrive()` check requires bundle id === plugin id).
 *
 * Both bundles replicate the official DSH client-bundle preset:
 * - externals resolve through the loader module table at runtime (react,
 *   react-dom, cordis, the client runtime),
 * - everything else is inlined into the bundle,
 * - the purity gate rejects any other @deepseek-ai value import:
 *   cross-plugin collaboration goes through cordis services, never value
 *   imports (type-only imports are erased and never reach the gate),
 * - each artifact registers itself via window.__ModuleLoader__.load({id,
 *   factory}) with the (require) => exports CJS closure shape.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((id) => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list, plus the runtime/client exemption). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Wire/type layers a client bundle may inline (mirror of the official
 * INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 * to share. Everything else under @deepseek-ai/* is either a module-table
 * entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = new URL(source, `file://${sourcemapPath}`).pathname
  const relative = physicalSource.replace(REPOSITORY_ROOT, '')
  return `../../../${relative}`
}

/** A rolldown plugin as tsdown's config accepts it (contextual `this` for resolveId). */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/** The shared client-bundle purity gate (see the header doc). */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing.
 * @param pluginId - the `__ModuleLoader__.load({ id })` value.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin()],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries;
      // code splitting would emit relative chunk URLs it cannot load.
      codeSplitting: false,
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted (and `watch` must never touch them).
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-recap', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-recap', 'client-registry.js'),
] satisfies UserConfig[]

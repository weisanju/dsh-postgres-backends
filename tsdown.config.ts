/**
 * tsdown build for dsh-postgres-backends: the browser client bundle
 * (lib/client.js, CJS closure factory) that registers with the package-name
 * id `dsh-postgres-backends` — the client-modules compose keys on the
 * package name; keep it in sync with package.json "name". The host-half lib
 * entries build with plain tsc (tsconfig.build.json), not tsdown.
 *
 * The client bundle replicates the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts) and the proven third-party shape of
 * dsh-better-sidebar:
 * - externals resolve through the loader module table at runtime (the
 *   PLATFORM_MODULES seed list from apps/web's platform.ts),
 * - everything else is inlined into the bundle,
 * - the artifact registers itself via window.__ModuleLoader__.load({ id,
 *   factory }) with the (require) => exports CJS closure shape,
 * - CSS Modules compile to hashed class maps and inject
 *   <style data-plugin="<id>"> tags at factory execution (lightningcss).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list). */
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

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/**
 * CSS Modules via lightningcss: import "x.module.css" yields the hashed
 * class map and auto-injects the style tag at factory execution. Mirror of
 * the official preset's virtual-id wrapper (the suffix keeps tsdown's own
 * css pipeline out of the picture).
 */
function makeCssPlugin(pluginId: string): NonNullable<UserConfig['plugins']> {
  return {
    name: 'dsh-postgres-backends:module-css',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.module.css')) return
      // Resolve relative specs against the importer, like Node resolution.
      const resolved = source.startsWith('.')
        ? resolvePath(dirname(importer ?? REPOSITORY_ROOT), source)
        : source
      return `${CSS_VIRTUAL_PREFIX}${resolved}${CSS_VIRTUAL_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return
      const file = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const text = await readFile(file, 'utf8')
      const { code, exports: classMap } = transform({
        filename: file,
        code: Buffer.from(text),
        cssModules: true,
        minify: false,
      })
      const classes = Object.fromEntries(Object.entries(classMap).map(([k, v]) => [k, v.name]))
      return [
        injectTag(pluginId, basename(file), code.toString()),
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/console/client/index.tsx' },
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
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [makeCssPlugin(pluginId)],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

export default function defineConfig(): UserConfig[] {
  return [
    clientBundle('dsh-postgres-backends', 'client.js'),
    // The host-half node entries build with tsc; keep tsdown scoped to the
    // client bundle only.
  ]
}
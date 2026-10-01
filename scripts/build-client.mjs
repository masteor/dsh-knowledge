import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { knowledgeDesignCss } from '../lib/design-tokens.js'
import { build } from 'esbuild'

const pluginId = '@lemoncat7/dsh-knowledge'

// charset: 'utf8' обязателен во ВСЕХ сборках esbuild.
// По умолчанию esbuild ставит charset: 'ascii' и переписывает любой не-ASCII
// текст в \uXXXX-последовательности. Снаружи это выглядит как «в файле нет
// иероглифов»: grep по 知识库 даёт ноль совпадений, хотя UI остаётся китайским.
// Именно так 1244 иероглифа прожили незамеченными. См. ловушку №11 в скилле
// localize-dsh-plugin. НЕ убирай charset — иначе проверки снова ослепнут.
//
// ВАЖНО: это лечит только esbuild. Вывод tsc (lib/*.tsx → lib/*.js) экранирует
// не-ASCII в JSX-атрибутах самостоятельно, и опции отключить это у tsc НЕТ.
// Поэтому такие файлы проходят через scripts/decode-tsc-escapes.mjs после сборки.

await build({ charset: 'utf8', entryPoints: ['worklog/index.js'], outfile: 'lib/worklog-runtime.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external' })
await mkdir('lib/worklog', { recursive: true })
await build({ charset: 'utf8', entryPoints: ['worklog/web-entry.jsx'], outfile: 'lib/worklog/workspace.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' } })
await writeFile('lib/worklog/workspace.css', await readFile('worklog/client.css', 'utf8') + '\n' + await readFile('worklog/web-embedded.css', 'utf8'))

await build({ charset: 'utf8',
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  ],
  loader: { '.css': 'text' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

await build({ charset: 'utf8',
  entryPoints: ['src/web-markdown-preview.ts'],
  outfile: 'web/markdown-preview.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeMarkdown',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await writeFile('web/design-tokens.css', knowledgeDesignCss() + '\n')

await build({ charset: 'utf8',
  entryPoints: ['src/web-note-editor.ts'],
  outfile: 'web/note-editor.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeNoteEditor',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({ charset: 'utf8',
  entryPoints: ['src/web-note-history.ts'],
  outfile: 'web/note-history.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeNoteHistory',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({ charset: 'utf8',
  entryPoints: ['src/web-change-review.ts'],
  outfile: 'web/change-review.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeReview',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

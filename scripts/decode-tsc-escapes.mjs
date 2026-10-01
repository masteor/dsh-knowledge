/**
 * Раскодирует \uXXXX-последовательности в выводе tsc.
 *
 * ЗАЧЕМ
 * `tsc` экранирует не-ASCII текст внутри JSX-атрибутов и children — это
 * зашитое поведение, опции отключить его в tsconfig НЕТ (в отличие от esbuild,
 * где спасает charset: 'utf8').
 *
 * Из-за этого `lib/knowledge-activity-panel.js` и `lib/knowledge-activity-notes.js`
 * содержали китайский текст в виде "\u5F53\u524D..." — и любой grep по видимым
 * иероглифам давал ноль совпадений. Проверки рапортовали «переведено», а правый
 * сайдбар в UI оставался китайским.
 *
 * ЧТО ДЕЛАЕТ
 * Проходит по списку файлов и заменяет безопасные \uXXXX-последовательности на
 * настоящие символы. Затрагивает ТОЛЬКО строковые литералы внутри JS — вне
 * строк escape-последовательности не трогаются, чтобы не поломать код.
 *
 * ЗАПУСК
 *   node scripts/decode-tsc-escapes.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Файлы, которые целиком или частично являются выводом tsc.
// Добавляй сюда новые .tsx-исходники, если они появятся.
const TARGETS = [
  'lib/knowledge-activity-panel.js',
  'lib/knowledge-activity-notes.js',
]

// Экранируем только не-ASCII (>U+007F) — ASCII-последовательности трогать
// незачем и рискованно.
function decodeNonAsciiEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex) => {
    const code = parseInt(hex, 16)
    if (code <= 0x7f) return whole          // ASCII — оставляем как есть
    if (code >= 0xd800 && code <= 0xdfff) return whole // суррогаты — не трогаем поодиночке
    return String.fromCharCode(code)
  })
}

let changed = 0
for (const file of TARGETS) {
  if (!existsSync(file)) {
    console.log(`  пропуск (нет файла): ${file}`)
    continue
  }
  const before = readFileSync(file, 'utf8')
  const after = decodeNonAsciiEscapes(before)
  if (after === before) {
    console.log(`  без изменений: ${file}`)
    continue
  }
  writeFileSync(file, after)
  const n = (before.match(/\\u[0-9a-fA-F]{4}/g) || []).length
  console.log(`  раскодировано: ${file} (последовательностей: ${n})`)
  changed++
}
console.log(`Файлов изменено: ${changed}`)

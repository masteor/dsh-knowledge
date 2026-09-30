/**
 * Извлекает пары «китайский → русский» из разницы между upstream/main и ru-localization.
 * Основа автоматического переноса перевода на новые версии.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CJK = /[\u4e00-\u9fff]/;
const CYR = /[\u0400-\u04FF]/;

function git(cmd) { return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

// Список изменённых файлов
const files = git('git diff --name-only upstream/main...ru-localization')
  .split('\n').map(s => s.trim()).filter(Boolean)
  .filter(f => /\.(js|jsx|ts|tsx|md)$/.test(f) && f !== 'CONTRIBUTORS.md');

console.log('Файлов к обработке: ' + files.length);

// Извлекаем строковые литералы (все типы кавычек)
function literals(text) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

const pairs = new Map();
let conflictFiles = 0;

for (const f of files) {
  let orig, mine;
  try {
    orig = git(`git show upstream/main:${f}`);
    mine = execSync(`cat ${JSON.stringify(f)}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch { continue; }

  const lo = literals(orig).filter(s => CJK.test(s));
  const ln = literals(mine).filter(s => CYR.test(s) && !CJK.test(s));

  if (lo.length !== ln.length) {
    console.log(`  ⚠ ${f}: литералов не совпадает (${lo.length} → ${ln.length}) — пропуск`);
    conflictFiles++;
    continue;
  }
  for (let i = 0; i < lo.length; i++) {
    if (!pairs.has(lo[i])) pairs.set(lo[i], ln[i]);
  }
}

console.log('Собрано пар: ' + pairs.size);
console.log('Файлов с расхождением: ' + conflictFiles);

const obj = Object.fromEntries([...pairs.entries()].sort((a, b) => b[0].length - a[0].length));
writeFileSync(process.argv[2] || '/tmp/pairs.json', JSON.stringify(obj, null, 0));
console.log('Записано в ' + (process.argv[2] || '/tmp/pairs.json'));

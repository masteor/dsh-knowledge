#!/usr/bin/env node
/**
 * Автолокализация новой версии upstream.
 *
 * ЗАДАЧА
 * После выхода новой версии плагина нужно перенести русский перевод на
 * изменившийся код — без ручного слияния 47 файлов.
 *
 * ПОДХОД
 * Слияние (git merge) здесь плохо работает: переведённые строки и строки
 * автора живут в одних и тех же местах, поэтому конфликты почти в каждом
 * файле. Вместо слияния — ПЕРЕПРИМЕНЕНИЕ ПО СЛОВАРЮ:
 *
 *   1. Берём свежий upstream и вливаем его в main (чистое зеркало).
 *   2. Ветку перевода ПЕРЕСОЗДАЁМ от нового main.
 *   3. Накладываем словарь переводов на новый код.
 *
 * Словарь (i18n/pairs.json) собирается из уже сделанного перевода и
 * содержит пары «китайский литерал → русский литерал». Он не зависит от
 * версии: если автор переписал код, но строка осталась той же — перевод
 * применится сам.
 *
 * Новые строки, которых нет в словаре, выводятся списком: их надо
 * перевести (вручную или субагентом) и дописать в словарь.
 *
 * ЗАПУСК
 *   node update-localization.mjs            # перенести перевод на свежий upstream
 *   node update-localization.mjs --dry-run  # показать, что будет сделано
 *   node update-localization.mjs --report   # только список непереведённых строк
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const PAIRS_FILE = join(DIR, "pairs.json");
// Отдельный слой: правки тестовых ожиданий. Тесты нельзя переводить словарём
// UI — там специфичные assert-строки, они обновляются только этими парами.
const TEST_PAIRS_FILE = join(DIR, "test-pairs.json");
// Путь к репозиторию с переводом. Ищется по порядку:
//   1) переменная окружения DSH_KNOWLEDGE_REPO
//   2) подкаталог ../repo рядом с этим скриптом (для переносимости)
//   3) типовое расположение на этой машине
function resolveRepo() {
  const candidates = [
    process.env.DSH_KNOWLEDGE_REPO,
    join(DIR, "..", "repo"),
    join(process.env.HOME || "", "Projects/tmp/dsh-knowledge"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c;
  return candidates[candidates.length - 1];
}
const REPO = resolveRepo();

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const REPORT_ONLY = args.includes("--report");

const CJK = /[\u4e00-\u9fff]/;

function git(cmd, opts = {}) {
  return execSync(`git ${cmd}`, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}
function log(m) { process.stdout.write("[i18n] " + m + "\n"); }

// ---------- проверки ----------
if (!existsSync(PAIRS_FILE)) {
  log("Нет словаря " + PAIRS_FILE);
  log("Собери его из текущего перевода: node extract-pairs.mjs");
  process.exit(1);
}
if (!existsSync(join(REPO, ".git"))) {
  log("Не git-репозиторий: " + REPO);
  process.exit(1);
}

const pairs = JSON.parse(readFileSync(PAIRS_FILE, "utf8"));
const keys = Object.keys(pairs).sort((a, b) => b.length - a.length); // длинные первыми
log(`Словарь: ${keys.length} пар`);

// ---------- состояние репозитория ----------
const branch = git("branch --show-current").trim();
log(`Репозиторий: ${REPO} (ветка ${branch})`);

if (!REPORT_ONLY) {
  const dirty = git("status --porcelain").trim();
  if (dirty) {
    log("Есть незакоммиченные изменения — сначала закоммить или спрячь:");
    log(dirty.split("\n").slice(0, 5).join("\n"));
    process.exit(1);
  }
}

// ---------- 1. тянем upstream ----------
if (!REPORT_ONLY) {
  log("Забираю upstream…");
  try { git("fetch upstream"); } catch { log("Не удалось fetch upstream — есть ли remote?"); process.exit(1); }
}

const behind = Number(git("rev-list --count main..upstream/main").trim() || "0");
log(`main отстаёт от upstream/main на ${behind} коммитов`);

if (behind === 0 && !REPORT_ONLY) {
  log("Обновлений нет — переносить нечего.");
}

// ---------- 2. анализ: какие китайские литералы остались бы без перевода ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// UI-файлы, которые пользователь реально видит. Исходники src/ сюда не входят
// намеренно: там внутренние тексты ошибок, которые мы не переводим (вариант C,
// см. patches.md). Иначе отчёт вечно показывал бы ~380 «непереведённых» строк.
const files = walk(REPO).filter(f =>
  !f.includes("/lib/") && !f.includes("/test/") && !f.includes("/src/") && !f.includes("/docs/"),
);
const untranslated = new Map(); // строка -> файлы

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lit = m[0];
    if (!CJK.test(lit)) continue;
    if (pairs[lit]) continue;                       // есть перевод в словаре
    if (lit.includes("依据")) continue;             // маркер протокола
    const rel = relative(REPO, f);
    if (!untranslated.has(lit)) untranslated.set(lit, new Set());
    untranslated.get(lit).add(rel);
  }
}

log("");
log(`Не переведено (нет в словаре): ${untranslated.size} строк`);
log("(учитываются только UI-файлы: web/ и worklog/; src/ и docs/ исключены)");
if (untranslated.size) {
  const out = [];
  for (const [lit, fs_] of [...untranslated.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out.push(lit);
  }
  writeFileSync(join(DIR, "untranslated.txt"), out.join("\n") + "\n");
  log("Список записан: i18n/untranslated.txt");
  log("Первые 10:");
  out.slice(0, 10).forEach(s => log("  " + s.slice(0, 80)));
}

if (REPORT_ONLY) process.exit(0);

// ---------- 3. перенос ----------
// Словарь содержит два вида ключей:
//   1) целые строковые литералы вместе с кавычками: 'текст' / `текст`
//   2) JSX-текст между тегами, без кавычек: <h3>текст</h3>
// Обрабатываем оба, иначе часть worklog останется китайской.
function applyPairs(text, pairs, keys) {
  let n = 0;
  // ЛИТЕРАЛЫ (ключ начинается с кавычки) — заменяем как есть: границы заданы кавычками.
  // JSX-ТЕКСТ (без кавычек) — ТОЛЬКО по границам тегов/вставок.
  //
  // Без этого короткий JSX-ключ вроде «中央日报 · 本机待上传» заменяется ВНУТРИ
  // более длинной строки и даёт мешанину: «… · ожидает загрузки с этого
  // устройства {…} 条{…}». Это та же ловушка подстрок, что и с обычным текстом.
  for (const k of keys) {
    const isLiteral = k.startsWith("'") || k.startsWith('"') || k.startsWith("`");
    if (isLiteral) {
      if (text.includes(k)) { text = text.split(k).join(pairs[k]); n++; }
      continue;
    }
    // JSX: ищем только там, где фрагмент стоит между > и < (или рядом со вставкой {…})
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(>|\\}\\s*)\\s*${esc}\\s*(?=<|\\{)`, "g");
    const before = text;
    text = text.replace(re, (m, pre) => pre + pairs[k]);
    if (text !== before) n++;
  }
  return [text, n];
}
// План: влить upstream в main, ветку перевода пересоздать от main и наложить словарь.
log("");
log("ПЛАН:");
log(`  1. git checkout main && git merge upstream/main   ${behind ? "(" + behind + " коммитов)" : "(нечего)"}`);
log("  2. git checkout -B ru-localization main");
log("  3. наложить словарь на " + files.length + " файлов");
log("  4. собрать, прогнать тесты");
log("  5. закоммитить и запушить");

if (DRY) { log(""); log("--dry-run: ничего не изменено."); process.exit(0); }

// Шаг 1: main = upstream
git("checkout main");
try {
  git("merge --ff-only upstream/main");
  log("main обновлён до upstream/main");
} catch {
  log("ff-only не сработал — main разошёлся с upstream. Разберись вручную:");
  log("  cd " + REPO + " && git log --oneline main..upstream/main");
  process.exit(1);
}

// Шаг 2: ветка перевода от нового main
git("checkout -B ru-localization main");
log("Ветка ru-localization пересоздана от main");

// Шаг 3: наложение словаря
let applied = 0, touched = 0;
for (const f of files) {
  let text = readFileSync(f, "utf8");
  const before = text;
  const [next, n] = applyPairs(text, pairs, keys);
  text = next; applied += n;
  if (text !== before) { writeFileSync(f, text); touched++; }
}
log(`Наложено пар: ${applied} (файлов изменено: ${touched})`);

// Шаг 3b: правки тестовых ожиданий (отдельный слой)
if (existsSync(TEST_PAIRS_FILE)) {
  const tp = JSON.parse(readFileSync(TEST_PAIRS_FILE, "utf8"));
  const tkeys = Object.keys(tp).sort((a, b) => b.length - a.length);
  let tApplied = 0, tFiles = 0;
  const testFiles = [];
  const walkTest = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p2 = join(d, e.name);
      if (e.isDirectory()) walkTest(p2);
      else if (/\.mjs$/.test(e.name)) testFiles.push(p2);
    }
  };
  const testDir = join(REPO, "test");
  if (existsSync(testDir)) walkTest(testDir);
  for (const f of testFiles) {
    let t = readFileSync(f, "utf8");
    const b = t;
    for (const k of tkeys) if (t.includes(k)) { t = t.split(k).join(tp[k]); tApplied++; }
    if (t !== b) { writeFileSync(f, t); tFiles++; }
  }
  log(`Правок в тестах: ${tApplied} (файлов: ${tFiles})`);
}

// Восстановить CONTRIBUTORS.md (не из upstream)
const contrib = join(DIR, "CONTRIBUTORS.md");
if (existsSync(contrib)) {
  writeFileSync(join(REPO, "CONTRIBUTORS.md"), readFileSync(contrib, "utf8"));
  log("CONTRIBUTORS.md восстановлен");
}

log("");
log("Дальше вручную:");
log("  cd " + REPO);
log("  npm run build && npm test");
log("  git add -A && git commit && git push origin ru-localization");
if (untranslated.size) {
  log("");
  log(`⚠ Осталось непереведённых строк: ${untranslated.size} — см. i18n/untranslated.txt`);
  log("  Переведи их, допиши в pairs.json и запусти скрипт снова.");
}

/**
 * Как звучит слово, написанное латиницей.
 *
 * Проблема, которую это решает: человек говорит «зум», «телеграм», «докер», а в
 * словаре у него записано `Zoom`, `Telegram`, `Docker`. Движок честно пишет то,
 * что услышал, — кириллицей; замена по словарю не срабатывала, потому что
 * `Зум` и `Zoom` — разные строки. Раньше это лечилось только вручную: указать
 * произношение у каждого слова.
 *
 * Здесь — известные пары «как пишется / как звучит по-русски». Список короткий и
 * ручной намеренно: машинная транслитерация даёт «зоом» и «доккер», то есть
 * делает вид, что знает произношение, которого не знает. Лучше 60 верных пар и
 * честное «произношение можно указать самому», чем тысяча выдуманных.
 *
 * Латиница ↔ кириллица работает в обе стороны: слово из словаря может быть
 * записано и так, и так.
 */

/** Известные пары. Ключ — латиница в нижнем регистре, значение — как звучит. */
const LATIN_TO_RU = {
  zoom: ['зум'],
  telegram: ['телеграм', 'телеграмм'],
  docker: ['докер'],
  github: ['гитхаб'],
  gitlab: ['гитлаб'],
  excel: ['эксель', 'иксель'],
  word: ['ворд'],
  powerpoint: ['пауэрпоинт', 'поверпоинт'],
  jira: ['джира', 'жира'],
  slack: ['слак'],
  notion: ['ноушн', 'ноушен'],
  figma: ['фигма'],
  trello: ['трелло'],
  asana: ['асана'],
  chrome: ['хром'],
  google: ['гугл'],
  youtube: ['ютуб', 'ютьюб'],
  whatsapp: ['ватсап', 'вотсап', 'вотсапп'],
  instagram: ['инстаграм'],
  facebook: ['фейсбук'],
  twitter: ['твиттер'],
  tiktok: ['тикток'],
  spotify: ['спотифай'],
  netflix: ['нетфликс'],
  windows: ['виндоус', 'виндовс'],
  linux: ['линукс'],
  macos: ['макос'],
  macbook: ['макбук'],
  iphone: ['айфон'],
  ipad: ['айпад'],
  android: ['андроид'],
  python: ['питон', 'пайтон'],
  javascript: ['джаваскрипт'],
  typescript: ['тайпскрипт'],
  react: ['реакт'],
  node: ['ноуд'],
  postgres: ['постгрес', 'постгресс'],
  postgresql: ['постгрес', 'постгресс'],
  redis: ['редис'],
  mongodb: ['монго'],
  kubernetes: ['кубернетес', 'кубернетикс'],
  nginx: ['нгинкс', 'энджинкс'],
  apache: ['апач', 'апачи'],
  jenkins: ['дженкинс'],
  kafka: ['кафка'],
  swift: ['свифт'],
  kotlin: ['котлин'],
  rust: ['раст'],
  api: ['апи'],
  json: ['джейсон', 'джисон'],
  sql: ['эс кью эл', 'сиквел'],
  aws: ['авс', 'а вэ эс'],
  azure: ['ажур', 'эжур'],
  openai: ['опенэйай', 'опенэйай'],
  chatgpt: ['чатджипити', 'чат гпт'],
  gpt: ['гпт'],
  whisper: ['виспер'],
  gmail: ['джимейл'],
  outlook: ['аутлук'],
  teams: ['тимс'],
  yandex: ['яндекс'],
  sber: ['сбер'],
  tinkoff: ['тинькофф'],
  visa: ['виза'],
  mastercard: ['мастеркард'],
  git: ['гит'],
  npm: ['нпм', 'эн пи эм'],
  vscode: ['вс код', 'ви эс код'],
  jupyter: ['джюпитер', 'юпитер'],
  pandas: ['пандас'],
  numpy: ['намп', 'нумпай'],
  tensorflow: ['тензорфлоу'],
  pytorch: ['пайторч'],
  huawei: ['хуавей'],
  xiaomi: ['сяоми'],
  samsung: ['самсунг'],
  apple: ['эппл'],
  microsoft: ['майкрософт'],
  ubuntu: ['убунту', 'убунта'],
  debian: ['дебиан'],
};

const norm = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/** Обратная карта: «зум» → [zoom]. Собирается один раз. */
const RU_TO_LATIN = (() => {
  const map = new Map();
  for (const [latin, sounds] of Object.entries(LATIN_TO_RU)) {
    for (const sound of sounds) {
      const key = norm(sound);
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(latin)) map.get(key).push(latin);
    }
  }
  return map;
})();

/** Все известные написания слова: латиница, кириллица и обратное направление. */
export function aliasesFor(word = '') {
  const key = norm(word);
  if (!key) return [];
  const out = [];
  const push = (value) => {
    const v = norm(value);
    if (v && v !== key && !out.includes(v)) out.push(v);
  };
  for (const sound of LATIN_TO_RU[key] || []) push(sound);
  for (const latin of RU_TO_LATIN.get(key) || []) {
    push(latin);
    for (const sound of LATIN_TO_RU[latin] || []) push(sound);
  }
  return out;
}

/** Знает ли приложение, как это слово звучит. Нужно для подсказки в словаре. */
export function knownAliases(word = '') {
  return aliasesFor(word);
}

/**
 * Все написания, которые считаются этим словом при замене и при подсчёте
 * попаданий: сам термин, указанное произношение и известные пары.
 * Порядок важен: сначала то, что написал человек.
 */
export function termVariants(entry) {
  const word = typeof entry === 'object' && entry ? String(entry.word || '').trim() : String(entry || '').trim();
  const pronunciation =
    typeof entry === 'object' && entry ? String(entry.pronunciation || '').trim() : '';
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    const key = norm(v);
    if (!key) return;
    if (out.some((existing) => norm(existing) === key)) return;
    out.push(v);
  };
  push(word);
  push(pronunciation);
  for (const alias of aliasesFor(word)) push(alias);
  return out;
}

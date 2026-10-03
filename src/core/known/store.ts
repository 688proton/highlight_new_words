import { browser } from 'wxt/browser';
import { STORAGE_KEYS, localBookKey, sourceBookKey } from '../storage/keys';
import { withStorageLock } from '../storage/lock';
import { hasOwnKey } from '../storage/own-record';
import { applyKnownChange, normalizeKnown } from './merge';
import type { KnownExportFormat, KnownWordsData } from './types';
import { normalizeSettings } from '../settings/migrate';
import type { Settings } from '../settings/schema';
import { bookKindOf } from '../wordbook/ids';
import { DefaultWordBookRegistry, createExtensionLoaders, localBookMeta, sourceBookMeta } from '../wordbook/registry';
import type { LocalBookIndex, SourceBookIndex, WordBook, WordBookRegistry } from '../wordbook/types';
import { isEffectiveKnownBook } from './sources';

/**
 * 熟词本存储读写（任何上下文可读；写入请在 background 或扩展页面中进行，内容脚本通过 markKnown/unmarkKnown 消息）。
 * 标记熟词的完整流程（含 deleteOnKnown 删除来源词）由 background 的 markKnown 消息处理，见 background/known.ts。
 */

export async function getKnownData(): Promise<KnownWordsData> {
  const res = await browser.storage.local.get(STORAGE_KEYS.knownWords);
  return normalizeKnown(res[STORAGE_KEYS.knownWords]);
}

/**
 * 生效熟词按判定口径分成两个集合（WordMatcher 的 known / knownBuiltin）：
 * - words：本地熟词本 ∪ 来源熟词本 ∪ 本地词书熟词本，宽口径（页面词的派生词根命中也算熟词，与既有行为一致）；
 * - builtin：内置词书熟词本（ladder 书为“低于本档”的补集），只按原词 + 屈折原形判断，
 *   避免大词表的派生词根误伤派生词（实测熟词=中考∪高考时，六级 138 个词只因派生词根命中被剔除，如 centralize、envious）。
 */
export interface KnownWordSets {
  words: Set<string>;
  builtin: Set<string>;
}

/**
 * 当前生效的熟词（小写），供 matcher 使用；有效熟词本的裁决见 known/sources.ts#isEffectiveKnownBook。
 *
 * 首屏关键路径，storage 往返与旧实现一样最多两次串行（不经 registry.list()，按 id 的类别直接加载）：
 * 1. 一次 get：本地熟词本 + settings（调用方已有时不读）+ 需要用到的来源/本地词书索引；
 * 2. 一次 get：生效的来源/本地熟词本的数据键。
 * 内置熟词本走 registry（扩展包 fetch），已有 settings 时与第 1 步并行发起。
 * @param registry 词书注册表：内容脚本传入自己的实例以共享已加载（预取）的词书文件；缺省用模块级共享实例（只加载内置书，数据随扩展包不变）
 * @param given 当前设置：内容脚本已持有，传入可省去一次读取
 */
export async function getKnownWordSets(registry?: WordBookRegistry, given?: Settings): Promise<KnownWordSets> {
  const enabledIds = given?.knownBooks.enabled;
  // settings 未知时无法预判熟词本类别，索引一并读出（只是元数据，体积小），换取不多一次往返
  const needSource = !enabledIds || enabledIds.some((id) => bookKindOf(id) === 'source');
  const needLocal = !enabledIds || enabledIds.some((id) => bookKindOf(id) === 'local');
  const keys: string[] = [STORAGE_KEYS.knownWords];
  if (!given) keys.push(STORAGE_KEYS.settings);
  if (needSource) keys.push(STORAGE_KEYS.sourceBooks);
  if (needLocal) keys.push(STORAGE_KEYS.localBooks);
  const firstRead = browser.storage.local.get(keys);
  const builtinReady = given ? loadBuiltinKnown(given, registry) : undefined;

  const res = await firstRead;
  const settings = given ?? normalizeSettings(res[STORAGE_KEYS.settings]);
  const words = new Set(Object.keys(normalizeKnown(res[STORAGE_KEYS.knownWords]).words));
  // 来源/本地熟词本：由索引构造元数据做裁决，再一次读出全部生效书的数据键
  const sourceIndex = res[STORAGE_KEYS.sourceBooks] as Partial<SourceBookIndex> | undefined;
  const localIndex = res[STORAGE_KEYS.localBooks] as Partial<LocalBookIndex> | undefined;
  const dataKeys: string[] = [];
  for (const id of new Set(settings.knownBooks.enabled)) {
    const kind = bookKindOf(id);
    const state = kind === 'source' ? sourceIndex?.books?.[id] : undefined;
    const meta = state ? sourceBookMeta(state) : kind === 'local' && localIndex?.books?.[id] ? localBookMeta(localIndex.books[id]!) : undefined;
    if (meta && isEffectiveKnownBook(settings, meta)) dataKeys.push(kind === 'source' ? sourceBookKey(id) : localBookKey(id));
  }
  const userData = dataKeys.length ? await browser.storage.local.get(dataKeys) : {};
  for (const k of dataKeys) {
    const data = userData[k] as { words?: Record<string, unknown> } | undefined;
    for (const w of Object.keys(data?.words ?? {})) words.add(w);
  }
  const builtin = await (builtinReady ?? loadBuiltinKnown(settings, registry));
  return { words, builtin };
}

/**
 * 模块级共享的内置词书注册表（未传 registry 时使用，即 background：每次打开卡片查词状态都要算熟词）：
 * 内置书文件与补集只加载一次（内置数据随扩展包发布，不会变）；registry 不缓存加载出错的书，下次调用只重取那几本，
 * 目录中没有的 id（同步过来的新版本词书、目录已删除的旧书）是确定结果，会被缓存，不会每次重新请求。
 * sharedBuiltinMemo 再按“启用了哪些内置熟词本”缓存并集：设置不变且每本书加载结果（对象）不变时直接复用同一个集合
 * （调用方不要修改返回的 builtin 集合）；之前失败的书重试成功后对象变了，并集随之重算。
 */
let sharedBuiltinRegistry: WordBookRegistry | undefined;
let sharedBuiltinMemo: { key: string; books: (WordBook | undefined)[]; words: Set<string> } | undefined;

/** 内置熟词本（ladder 书为“低于本档”的补集）的词并集；裁决需要 catalog 中的 ladder 字段，所以先加载再按 book.meta 判断 */
async function loadBuiltinKnown(settings: Settings, registry?: WordBookRegistry): Promise<Set<string>> {
  const ids = [...new Set(settings.knownBooks.enabled)].filter((id) => bookKindOf(id) === 'builtin');
  // 没有内置熟词本时不碰 registry（内置目录要 fetch 扩展包资源）
  if (ids.length === 0) return new Set();
  const reg = registry ?? (sharedBuiltinRegistry ??= new DefaultWordBookRegistry(createExtensionLoaders()));
  // registry 按 id 缓存加载结果，重复调用只是取缓存
  const books = await Promise.all(ids.map((id) => reg.loadAsKnown(id)));
  // 裁决只依赖熟词本 id 与生词本列表（非 ladder 书同在生词本时按生词本处理），以此作缓存键
  const memoKey = `${ids.join(',')}|${settings.books.enabled.join(',')}`;
  const shared = reg === sharedBuiltinRegistry;
  if (shared && sharedBuiltinMemo?.key === memoKey && sharedBuiltinMemo.books.every((b, i) => b === books[i])) return sharedBuiltinMemo.words;
  const out = new Set<string>();
  for (const book of books) {
    if (!book || !isEffectiveKnownBook(settings, book.meta)) continue;
    for (const w of book.words()) out.add(w);
  }
  if (shared) sharedBuiltinMemo = { key: memoKey, books, words: out };
  return out;
}

/**
 * 当前生效的全部熟词（getKnownWordSets 两个集合的并集，小写）：background 判断“该词仍在启用的熟词本中”等提示用。
 * 只编辑本地熟词本的场景（options 熟词管理、storage.sync）请用 getKnownData，不要用本函数。
 */
export async function getKnownWords(): Promise<Set<string>> {
  const { words, builtin } = await getKnownWordSets();
  for (const w of builtin) words.add(w);
  return words;
}

/** 单词（小写原形）是否在当前生效的熟词中：background 查词状态、撤销提示用，不必像 getKnownWords 那样复制出并集 */
export async function isKnownWord(word: string): Promise<boolean> {
  const { words, builtin } = await getKnownWordSets();
  return words.has(word) || builtin.has(word);
}

export async function saveKnownData(data: KnownWordsData): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.knownWords]: data });
}

/** 加入（known=true）或撤销（false）熟词，带锁的读改写；返回最新熟词数 */
export function setKnownWords(words: Iterable<string>, known: boolean): Promise<number> {
  const list = [...words];
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const next = applyKnownChange(await getKnownData(), list, known);
    await saveKnownData(next);
    return Object.keys(next.words).length;
  });
}

/** 用新列表整体替换熟词本（options 文本框编辑）：新增的记加入时间，删除的记墓碑 */
export function replaceKnownWords(list: Iterable<string>): Promise<number> {
  const target = new Set([...list].map((w) => w.trim().toLowerCase()).filter(Boolean));
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const cur = await getKnownData();
    const removed = Object.keys(cur.words).filter((w) => !target.has(w));
    const added = [...target].filter((w) => !hasOwnKey(cur.words, w));
    const next = applyKnownChange(applyKnownChange(cur, added, true), removed, false);
    await saveKnownData(next);
    return Object.keys(next.words).length;
  });
}

/** 导入熟词（与现有合并，不删除），返回新增数量。words 来自 core/import 的 parseWordList */
export function importKnownWords(words: Iterable<string>): Promise<number> {
  const list = [...words];
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const cur = await getKnownData();
    const added = list.map((w) => w.trim().toLowerCase()).filter((w) => w && !hasOwnKey(cur.words, w));
    await saveKnownData(applyKnownChange(cur, added, true));
    return new Set(added).size;
  });
}

/** 导出熟词本文本：txt 一行一词；csv 含表头 word,addedAt（ISO 时间） */
export async function exportKnownWords(format: KnownExportFormat = 'txt'): Promise<string> {
  const entries = Object.entries((await getKnownData()).words).sort(([a], [b]) => a.localeCompare(b));
  if (format === 'txt') return entries.map(([w]) => w).join('\n') + '\n';
  return ['word,addedAt', ...entries.map(([w, t]) => `${w},${t ? new Date(t).toISOString() : ''}`)].join('\n') + '\n';
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { enabledKnownBookIds, isEffectiveKnownBook, isKnownOnlyBook } from '@/core/known/sources';
import { getKnownWords, getKnownWordSets, isKnownWord } from '@/core/known/store';
import type { Lemmatizer } from '@/core/lemma/types';
import { WordMatcher } from '@/core/match/matcher';
import { createDefaultSettings } from '@/core/settings/defaults';
import { MY_WORDS_BOOK_ID, type Settings } from '@/core/settings/schema';
import { STORAGE_KEYS, localBookKey, sourceBookKey } from '@/core/storage/keys';
import { DefaultWordBookRegistry, createSetWordBook, knownBookFileIds, localBookMeta, sourceBookMeta, type RegistryLoaders } from '@/core/wordbook/registry';
import type { BookCatalog, BookDataFile, BookMeta, CatalogBookMeta, LocalBookData, LocalBookIndex, SourceBookData, SourceBookIndex, SourceBookState } from '@/core/wordbook/types';
import {
  allBooksSelected,
  CATEGORY_GROUPS,
  bookMatchesQuery,
  bookUsageOf,
  canUseAsKnown,
  hasLadderBooks,
  matchesUsageFilter,
  selectAllIds,
  setBookUsage,
  toggleAllBooks,
  toggleBook,
  toggleBookUsage,
} from '@/entrypoints/options/lib/books';
import { wordActionOptions } from '@/entrypoints/options/lib/word-actions';
import { groupBooks, newBookChoices, setNewBookEnabled } from '@/entrypoints/popup/model';

/**
 * 打包目录（toggleBook 不传元数据时的兜底）换成 fixture，不依赖 public/data 生成产物。
 * vi.mock 会提升到 import 之前执行，工厂内不能引用下面的常量，只列测试用到的书。
 */
vi.mock('@/core/wordbook/packaged-catalog', () => {
  const m = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, nameEn: id, short: id, category: 'exam', level: 1, size: 0, kind: 'builtin', ...extra });
  const books = [
    m('cefr-a2', { category: 'level', level: 2, ladder: 'cefr' }),
    m('cefr-b1', { category: 'level', level: 3, ladder: 'cefr' }),
    m('cefr-b2', { category: 'level', level: 4, ladder: 'cefr' }),
    m('cet4'),
    m('gk'),
    m('nawl', { category: 'domain' }),
    m('bsl', { category: 'domain' }),
    m('cs-250', { category: 'domain', group: 'cs', level: 1 }),
    m('cs-500', { category: 'domain', group: 'cs', level: 2 }),
    m('cs-all', { category: 'domain', group: 'cs', level: 3 }),
  ];
  return { PACKAGED_CATALOG: { version: 3, books, ladders: { cefr: { base: 'cefr-a1' } } }, packagedBuiltinMetas: () => books };
});

/**
 * 任意词书作熟词本（核心逻辑）：ladder 补集、生效裁决、内置熟词只按屈折判断、getKnownWordSets、词书三态 setter、popup 过滤。
 * 数据用 fixture，不依赖 public/data 生成产物。
 */

const cat = (id: string, extra: Partial<CatalogBookMeta> = {}): CatalogBookMeta => ({ id, name: id, nameEn: id, short: id, category: 'exam', level: 1, size: 0, ...extra });

/** 迷你 cefr/coca 体系：文件只存本档自身词，extends 指向更高档（与 build-data 产物结构一致） */
const CATALOG: BookCatalog = {
  version: 3,
  books: [
    cat('cefr-a2', { category: 'level', level: 2, ladder: 'cefr', knownName: 'A1（A2 以下）' }),
    cat('cefr-b1', { category: 'level', level: 3, ladder: 'cefr', knownName: 'A1–A2（B1 以下）' }),
    cat('cefr-b2', { category: 'level', level: 4, ladder: 'cefr', knownName: 'A1–B1（B2 以下）' }),
    cat('coca-3k', { category: 'frequency', level: 3, ladder: 'coca', knownName: '常用前 3000 词' }),
    cat('coca-5k', { category: 'frequency', level: 5, ladder: 'coca', knownName: '常用前 5000 词' }),
    cat('cet4'),
    cat('cs-250', { category: 'domain', group: 'cs', level: 1 }),
    cat('cs-500', { category: 'domain', group: 'cs', level: 2 }),
    cat('cs-all', { category: 'domain', group: 'cs', level: 3 }),
  ],
  ladders: { cefr: { base: 'cefr-a1' }, coca: { base: 'coca-top' } },
};
const FILES: Record<string, BookDataFile> = {
  'cefr-a1': { id: 'cefr-a1', words: ['apple', 'go'] },
  'cefr-a2': { id: 'cefr-a2', words: ['travel'], extends: ['cefr-b1'] },
  'cefr-b1': { id: 'cefr-b1', words: ['care', 'argue'], extends: ['cefr-b2'] },
  'cefr-b2': { id: 'cefr-b2', words: ['abandon', 'careless'] },
  'coca-top': { id: 'coca-top', words: ['the', 'go'] },
  'coca-3k': { id: 'coca-3k', words: ['budget'], extends: ['coca-5k'] },
  'coca-5k': { id: 'coca-5k', words: ['scrutinize'] },
  cet4: { id: 'cet4', words: ['abandon', 'care'] },
  'cs-250': { id: 'cs-250', words: ['algorithm'] },
  'cs-500': { id: 'cs-500', words: ['algorithm', 'compiler'] },
  'cs-all': { id: 'cs-all', words: ['algorithm', 'compiler', 'tuple'] },
};

function memoryLoaders(catalog: BookCatalog = CATALOG, files: Record<string, BookDataFile> = FILES, extra: Partial<RegistryLoaders> = {}): RegistryLoaders & { book: ReturnType<typeof vi.fn> } {
  return {
    catalog: async () => catalog,
    sourceIndex: async () => ({ books: {}, providers: {} }),
    sourceBook: async () => undefined,
    localIndex: async () => ({ books: {}, removed: {} }),
    localBook: async () => undefined,
    ...extra,
    book: vi.fn(async (id: string) => {
      const f = files[id];
      if (!f) throw new Error('404 ' + id);
      return f;
    }),
  };
}

const sorted = (it: Iterable<string>) => [...it].sort();

describe('registry.loadAsKnown：ladder 书作熟词本 = 低于本档的补集', () => {
  it('cefr-b2 作熟词本 = base(A1) ∪ A2、B1 自身词（不沿 extends 往上合并），名称用 knownName；load 仍是本档及以上', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders());
    const known = await reg.loadAsKnown('cefr-b2');
    expect(sorted(known!.words())).toEqual(['apple', 'argue', 'care', 'go', 'travel']);
    expect(known!.meta.name).toBe('A1–B1（B2 以下）');
    expect(sorted((await reg.load('cefr-b2'))!.words())).toEqual(['abandon', 'careless']);
    // 两个结果分别缓存
    expect(await reg.loadAsKnown('cefr-b2')).toBe(known);
    expect(await reg.load('cefr-b2')).not.toBe(known);
  });

  it('最低档作熟词本 = base；coca-5k 作熟词本 = 前 3000 ∪ 3000–5000 段', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders());
    expect(sorted((await reg.loadAsKnown('cefr-a2'))!.words())).toEqual(['apple', 'go']);
    expect(sorted((await reg.loadAsKnown('coca-3k'))!.words())).toEqual(['go', 'the']);
    expect(sorted((await reg.loadAsKnown('coca-5k'))!.words())).toEqual(['budget', 'go', 'the']);
  });

  it('非 ladder 书（考试书、group 书）作熟词本就是书本身', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders());
    expect(await reg.loadAsKnown('cet4')).toBe(await reg.load('cet4'));
    expect(sorted((await reg.loadAsKnown('cs-500'))!.words())).toEqual(['algorithm', 'compiler']);
    expect(await reg.loadAsKnown('nope')).toBeUndefined();
  });

  it('base 文件缺失或未声明 ladders：退化为只取更低各档，不让整本失效', async () => {
    const missingBase = { ...FILES };
    delete missingBase['cefr-a1'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new DefaultWordBookRegistry(memoryLoaders(CATALOG, missingBase));
    expect(sorted((await reg.loadAsKnown('cefr-b1'))!.words())).toEqual(['travel']);
    const noLadders = new DefaultWordBookRegistry(memoryLoaders({ ...CATALOG, ladders: undefined }));
    expect(sorted((await noLadders.loadAsKnown('cefr-a2'))!.words())).toEqual([]);
    warn.mockRestore();
  });

  it('load 与 loadAsKnown 共用文件缓存：同一文件只请求一次', async () => {
    const loaders = memoryLoaders();
    const reg = new DefaultWordBookRegistry(loaders);
    await Promise.all([reg.load('cefr-a2'), reg.loadAsKnown('cefr-b2')]);
    const calls = loaders.book.mock.calls.map((c) => c[0]);
    expect(calls.filter((id) => id === 'cefr-b1')).toHaveLength(1);
  });

  it('knownBookFileIds：ladder 书为 base + 更低各档，其它书为自身，未知书为空（content 首屏预取用）', () => {
    expect(knownBookFileIds(CATALOG, 'cefr-b2')).toEqual(['cefr-a1', 'cefr-a2', 'cefr-b1']);
    expect(knownBookFileIds(CATALOG, 'coca-3k')).toEqual(['coca-top']);
    expect(knownBookFileIds(CATALOG, 'cet4')).toEqual(['cet4']);
    expect(knownBookFileIds(CATALOG, 'nope')).toEqual([]);
  });
});

// ---------------- 生效裁决 ----------------

const builtin = (m: CatalogBookMeta): BookMeta => ({ ...m, kind: 'builtin' });
const srcState = (id: string, extra: Partial<SourceBookState> = {}): SourceBookState => ({
  id, providerId: 'eudic', remoteId: id.split(':')[2]!, name: id, status: 'ok', lastSyncAt: 1, lastAttemptAt: 1, wordCount: 1, ...extra,
});
const localMeta = (id: string, name = id) => localBookMeta({ id, name, format: 'txt', fileName: `${name}.txt`, wordCount: 1, createdAt: 1, updatedAt: 1 });

const B = Object.fromEntries(CATALOG.books.map((m) => [m.id, builtin(m)])) as Record<string, BookMeta>;
const MASTERED = sourceBookMeta(srcState('src:eudic:mastered', { role: 'known' }));
const EU1 = sourceBookMeta(srcState('src:eudic:1'));
const LOCAL = localMeta('local:a', '托福核心');
const MINE = localMeta(MY_WORDS_BOOK_ID, '我的生词本');
const ALL: BookMeta[] = [MASTERED, EU1, LOCAL, MINE, ...Object.values(B)];

function settingsWith(newIds: string[], knownIds: string[], roles: Settings['knownBooks']['roles'] = {}): Settings {
  const s = createDefaultSettings();
  s.books.enabled = newIds;
  s.knownBooks = { enabled: knownIds, roles };
  return s;
}

describe('enabledKnownBookIds：统一裁决（books.enabled 优先）', () => {
  it('来源书看生效角色；本地书排除“我的生词本”与同在生词本的；内置非 ladder 书同在生词本时按生词本；ladder 书可两表同时', () => {
    const s = settingsWith(['cet4', 'cefr-b2', 'local:a'], ['src:eudic:mastered', 'src:eudic:1', 'local:a', MY_WORDS_BOOK_ID, 'cet4', 'cefr-b2', 'cs-250', 'gone', 'cs-250']);
    expect(enabledKnownBookIds(s, ALL)).toEqual(['src:eudic:mastered', 'cefr-b2', 'cs-250']);
    // 用户把自建分组改为熟词本后生效
    s.knownBooks.roles = { 'src:eudic:1': 'known' };
    expect(enabledKnownBookIds(s, ALL)).toContain('src:eudic:1');
    // 本地书移出生词本后作熟词本生效
    s.books.enabled = [];
    expect(enabledKnownBookIds(s, ALL)).toEqual(['src:eudic:mastered', 'src:eudic:1', 'local:a', 'cet4', 'cefr-b2', 'cs-250']);
  });

  it('isKnownOnlyBook：来源熟词本即使未启用也算；ladder 书不算；生词本优先', () => {
    const s = settingsWith(['cet4'], ['cet4', 'cs-250', 'cefr-b2', 'local:a']);
    expect(isKnownOnlyBook(s, MASTERED)).toBe(true);
    expect(isKnownOnlyBook(s, EU1)).toBe(false);
    expect(isKnownOnlyBook(s, B['cs-250']!)).toBe(true);
    expect(isKnownOnlyBook(s, B['cet4']!)).toBe(false);
    expect(isKnownOnlyBook(s, B['cefr-b2']!)).toBe(false);
    expect(isKnownOnlyBook(s, LOCAL)).toBe(true);
    expect(isEffectiveKnownBook(s, B['cefr-b2']!)).toBe(true);
  });

  it('来源书也是 books.enabled 优先：熟词角色的来源书同在生词本时按生词本处理，生词开关列表保留它以便关掉', () => {
    // 旧版 popup 能把熟词角色的来源书加进生词本：此前既作生词本加载又作熟词，词全部被吞
    const s = settingsWith([MASTERED.id], [MASTERED.id]);
    expect(isEffectiveKnownBook(s, MASTERED)).toBe(false);
    expect(enabledKnownBookIds(s, ALL)).toEqual([]);
    expect(isKnownOnlyBook(s, MASTERED)).toBe(false);
    expect(newBookChoices(s, ALL).map((b) => b.id)).toContain(MASTERED.id);
    // 关掉生词本后恢复为熟词本
    s.books.enabled = [];
    expect(isEffectiveKnownBook(s, MASTERED)).toBe(true);
    expect(isKnownOnlyBook(s, MASTERED)).toBe(true);
  });
});

// ---------------- matcher：内置熟词本只按屈折判断 ----------------

describe('WordMatcher knownBuiltin：只按原词与屈折原形判断，不用派生词根', () => {
  /** 迷你还原器：carelessly -> careless -> care（派生），cares -> care（屈折） */
  const lemmatizer: Lemmatizer = {
    candidates: (w) => [w, ...(lemmatizer.analyze!(w).inflections), ...lemmatizer.analyze!(w).derivations].filter((x, i, a) => a.indexOf(x) === i),
    analyze: (w) => {
      const table: Record<string, { inflections: string[]; derivations: string[] }> = {
        cares: { inflections: ['care'], derivations: [] },
        carelessly: { inflections: [], derivations: ['careless', 'care'] },
        careless: { inflections: [], derivations: ['care'] },
        runners: { inflections: ['runner'], derivations: ['run'] },
      };
      return { base: w, inflections: table[w]?.inflections ?? [], derivations: table[w]?.derivations ?? [], fromTable: !!table[w] };
    },
  };
  const gre = createSetWordBook(B['cet4']!, ['care', 'careless', 'carelessly', 'runner']);

  it('内置熟词有 care：cares 不高亮，careless/carelessly 仍高亮；同一集合放在宽口径 known 中则全部被吞', () => {
    const strict = new WordMatcher({ lemmatizer, books: [gre], known: new Set(), knownBuiltin: new Set(['care']) });
    expect(strict.match('cares')).toBeNull();
    expect(strict.match('care')).toBeNull();
    expect(strict.match('careless')?.lemma).toBe('careless');
    expect(strict.match('carelessly')?.lemma).toBe('carelessly');
    const loose = new WordMatcher({ lemmatizer, books: [gre], known: new Set(['care']) });
    expect(loose.match('carelessly')).toBeNull();
  });

  it('没有 analyze 的还原器：判熟只比对原词，选出的 lemma 是内置熟词时仍不高亮', () => {
    const simple: Lemmatizer = { candidates: (w) => (w === 'cares' ? [w, 'care'] : w === 'careful' ? [w, 'careless'] : [w]) };
    const m = new WordMatcher({ lemmatizer: simple, books: [gre], known: new Set(), knownBuiltin: new Set(['care']) });
    expect(m.match('care')).toBeNull();
    expect(m.match('cares')).toBeNull();
    expect(m.match('careful')?.lemma).toBe('careless');
  });

  it('派生词退回到内置熟词才能命中生词本时不高亮（cet6 生词 + gk 熟词：abusive -> abuse）', () => {
    /** 生词本与熟词本有交集（非 ladder 书可同时含 abuse），页面词自身不在生词本 */
    const lem: Lemmatizer = {
      candidates: (w) => [w, ...(lem.analyze!(w).inflections), ...lem.analyze!(w).derivations].filter((x, i, a) => a.indexOf(x) === i),
      analyze: (w) => {
        const table: Record<string, { inflections: string[]; derivations: string[] }> = {
          abusive: { inflections: [], derivations: ['abuse'] },
          submissions: { inflections: ['submission'], derivations: ['submit'] },
          unhappiness: { inflections: [], derivations: ['unhappy', 'happy'] },
          studies: { inflections: ['study'], derivations: [] },
        };
        return { base: w, inflections: table[w]?.inflections ?? [], derivations: table[w]?.derivations ?? [], fromTable: !!table[w] };
      },
    };
    const cet6 = createSetWordBook(B['cet4']!, ['abuse', 'submit', 'happy', 'careless']);
    const m = new WordMatcher({ lemmatizer: lem, books: [cet6], known: new Set(), knownBuiltin: new Set(['abuse', 'submit', 'unhappy']) });
    expect(m.match('abusive')).toBeNull();
    expect(m.match('submissions')).toBeNull();
    // 中间候选 unhappy 是熟词：不再退到更远的词根 happy
    expect(m.match('unhappiness')).toBeNull();
    // 原词自身在生词本，不受熟词词根影响
    expect(m.match('careless')?.lemma).toBe('careless');
    // 用户词书变形条目归一后的原形是内置熟词：同样不高亮
    const local = createSetWordBook(localBookMeta({ id: 'local:x', name: 'x', format: 'txt', wordCount: 1, createdAt: 1, updatedAt: 1 }), ['studies']);
    const m2 = new WordMatcher({ lemmatizer: lem, books: [local], known: new Set(), knownBuiltin: new Set(['study']) });
    expect(m2.match('studies')).toBeNull();
  });

  it('页面词本身是内置生词本词条时不按屈折剔除（electronics、goods 是独立词条，不是 electronic、good 的复数）', () => {
    const lem: Lemmatizer = {
      candidates: (w) => [w, ...lem.analyze!(w).inflections],
      analyze: (w) => {
        const table: Record<string, string[]> = { electronics: ['electronic'], goods: ['good'], cares: ['care'] };
        return { base: w, inflections: table[w] ?? [], derivations: [], fromTable: !!table[w] };
      },
    };
    const b2 = createSetWordBook(B['cefr-b2']!, ['electronics', 'goods', 'careful']);
    const m = new WordMatcher({ lemmatizer: lem, books: [b2], known: new Set(), knownBuiltin: new Set(['electronic', 'good', 'care']) });
    expect(m.match('electronics')?.lemma).toBe('electronics');
    expect(m.match('goods')?.lemma).toBe('goods');
    // 不是词条的屈折形式照常按熟词剔除
    expect(m.match('cares')).toBeNull();
    // 用户词书不适用此例外（可能记了任意变形）
    const local = createSetWordBook(localBookMeta({ id: 'local:x', name: 'x', format: 'txt', wordCount: 1, createdAt: 1, updatedAt: 1 }), ['goods']);
    expect(new WordMatcher({ lemmatizer: lem, books: [local], known: new Set(), knownBuiltin: new Set(['good']) }).match('goods')).toBeNull();
  });
});

// ---------------- getKnownWordSets（fake-browser storage + 内存 registry） ----------------

describe('getKnownWordSets：按口径分成 words / builtin 两个集合', () => {
  beforeEach(() => fakeBrowser.reset());

  async function seed(knownIds: string[], newIds: string[] = []) {
    const s = settingsWith(newIds, knownIds);
    const srcIndex: SourceBookIndex = { books: { [MASTERED.id]: MASTERED.sync! }, providers: {} };
    const srcData: SourceBookData = { id: MASTERED.id, words: { criteria: { word: 'criteria' } }, updatedAt: 1 };
    const localIndex: LocalBookIndex = { books: { 'local:a': { id: 'local:a', name: '托福核心', format: 'txt', wordCount: 1, createdAt: 1, updatedAt: 1 } }, removed: {} };
    const localData: LocalBookData = { id: 'local:a', words: { studies: { word: 'studies' } } };
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.settings]: s,
      [STORAGE_KEYS.knownWords]: { words: { apple: 1 }, removed: {} },
      [STORAGE_KEYS.sourceBooks]: srcIndex,
      [sourceBookKey(MASTERED.id)]: srcData,
      [STORAGE_KEYS.localBooks]: localIndex,
      [localBookKey('local:a')]: localData,
    });
    return new DefaultWordBookRegistry(
      memoryLoaders(CATALOG, FILES, {
        sourceIndex: async () => srcIndex,
        sourceBook: async (id) => (id === MASTERED.id ? srcData : undefined),
        localIndex: async () => localIndex,
        localBook: async (id) => (id === 'local:a' ? localData : undefined),
      }),
    );
  }

  it('本地熟词本、来源熟词本、本地词书熟词本进 words；内置熟词本（ladder 取补集）进 builtin', async () => {
    const reg = await seed([MASTERED.id, 'local:a', 'cet4', 'coca-3k']);
    const sets = await getKnownWordSets(reg);
    expect(sorted(sets.words)).toEqual(['apple', 'criteria', 'studies']);
    expect(sorted(sets.builtin)).toEqual(['abandon', 'care', 'go', 'the']);
  });

  it('非 ladder 内置书同时在生词本时按生词本处理，不进熟词', async () => {
    const reg = await seed(['cet4', 'cefr-b1'], ['cet4', 'cefr-b1']);
    const sets = await getKnownWordSets(reg);
    expect(sorted(sets.builtin)).toEqual(['apple', 'go', 'travel']);
  });

  it('getKnownWords 返回并集；未启用熟词本时只有本地熟词本', async () => {
    await seed([MASTERED.id]);
    // 缺省 registry 走 storage：来源熟词本可读到（内置目录 fetch 失败时兜底为空目录）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sorted(await getKnownWords())).toEqual(['apple', 'criteria']);
    warn.mockRestore();
    await seed([]);
    expect(sorted(await getKnownWords())).toEqual(['apple']);
  });

  /** 记录 storage.local.get 的调用（键列表）；首屏关键路径上 storage 往返必须与旧实现一样最多两次串行 */
  function spyStorageGets(): string[][] {
    const calls: string[][] = [];
    const orig = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementation(async (keys?: any) => {
      calls.push(([] as string[]).concat(keys ?? []));
      return orig(keys);
    });
    return calls;
  }

  it('首屏：传入 settings 时 storage 只读两次（熟词+所需索引 → 生效书数据键），不读 settings、不经 registry.list', async () => {
    const reg = await seed([MASTERED.id, 'local:a', 'cet4']);
    const listSpy = vi.spyOn(reg, 'list');
    const settings = settingsWith([], [MASTERED.id, 'local:a', 'cet4']);
    const calls = spyStorageGets();
    const sets = await getKnownWordSets(reg, settings);
    expect(calls).toEqual([
      [STORAGE_KEYS.knownWords, STORAGE_KEYS.sourceBooks, STORAGE_KEYS.localBooks],
      [sourceBookKey(MASTERED.id), localBookKey('local:a')],
    ]);
    expect(listSpy).not.toHaveBeenCalled();
    expect(sorted(sets.words)).toEqual(['apple', 'criteria', 'studies']);
    expect(sorted(sets.builtin)).toEqual(['abandon', 'care']);
    vi.restoreAllMocks();
  });

  it('只有内置熟词本时 storage 只读一次；内置书加载与这次读取并行发起', async () => {
    const reg = await seed(['cet4']);
    const settings = settingsWith([], ['cet4']);
    const calls = spyStorageGets();
    const loadSpy = vi.spyOn(reg, 'loadAsKnown');
    const pending = getKnownWordSets(reg, settings);
    // 同步阶段已发起：storage 读取与内置书加载都不等对方
    expect(calls).toHaveLength(1);
    expect(loadSpy).toHaveBeenCalledWith('cet4');
    expect(sorted((await pending).builtin)).toEqual(['abandon', 'care']);
    expect(calls).toEqual([[STORAGE_KEYS.knownWords]]);
    vi.restoreAllMocks();
  });

  it('未传 settings（background）：第一次读取同时带上 settings 与两个索引，仍然最多两次', async () => {
    await seed([MASTERED.id]);
    const calls = spyStorageGets();
    const sets = await getKnownWordSets();
    expect(calls).toEqual([
      [STORAGE_KEYS.knownWords, STORAGE_KEYS.settings, STORAGE_KEYS.sourceBooks, STORAGE_KEYS.localBooks],
      [sourceBookKey(MASTERED.id)],
    ]);
    expect(sorted(sets.words)).toEqual(['apple', 'criteria']);
    vi.restoreAllMocks();
  });

  it('熟词角色的来源书同在生词本：books.enabled 优先，不读它的数据', async () => {
    const reg = await seed([]);
    const calls = spyStorageGets();
    const sets = await getKnownWordSets(reg, settingsWith([MASTERED.id], [MASTERED.id]));
    expect(calls).toEqual([[STORAGE_KEYS.knownWords, STORAGE_KEYS.sourceBooks]]);
    expect(sorted(sets.words)).toEqual(['apple']);
    vi.restoreAllMocks();
  });

  it('来源书角色改回生词本、本地书同在生词本、“我的生词本”：不读它们的数据', async () => {
    const reg = await seed([]);
    const settings = settingsWith(['local:a'], [MASTERED.id, 'local:a', MY_WORDS_BOOK_ID], { [MASTERED.id]: 'new' });
    const calls = spyStorageGets();
    const sets = await getKnownWordSets(reg, settings);
    expect(calls).toEqual([[STORAGE_KEYS.knownWords, STORAGE_KEYS.sourceBooks, STORAGE_KEYS.localBooks]]);
    expect(sorted(sets.words)).toEqual(['apple']);
    vi.restoreAllMocks();
  });
});

describe('background 查熟词（未传 registry）：内置熟词本只加载一次', () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(() => vi.unstubAllGlobals());

  it('isKnownWord / getKnownWords 多次调用复用共享注册表与并集；改设置后按新设置重算；加载失败的书下次重试', async () => {
    const fetched: string[] = [];
    let failCet4 = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^.*?data\/books\//, '').replace(/\.json$/, '');
      fetched.push(path);
      const body = path === 'index' ? CATALOG : FILES[path];
      if (!body || (path === 'cet4' && failCet4)) return new Response('', { status: 404 });
      return new Response(JSON.stringify(body));
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settingsWith([], ['cefr-b1', 'cet4']) });
    // cet4 加载失败：只有 B1 以下生效，且不缓存失败
    expect(await isKnownWord('travel')).toBe(true);
    expect(await isKnownWord('abandon')).toBe(false);
    failCet4 = false;
    expect(await isKnownWord('abandon')).toBe(true);
    const afterRetry = fetched.length;
    // 设置不变：不再请求任何文件
    expect(await isKnownWord('apple')).toBe(true);
    expect(sorted(await getKnownWords())).toEqual(['abandon', 'apple', 'care', 'go', 'travel']);
    expect(fetched.length).toBe(afterRetry);
    // cet4 同时启用为生词本：按生词本处理，不再算熟词；文件仍来自缓存
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settingsWith(['cet4'], ['cefr-b1', 'cet4']) });
    expect(await isKnownWord('abandon')).toBe(false);
    expect(await isKnownWord('travel')).toBe(true);
    expect(fetched.length).toBe(afterRetry);
    warn.mockRestore();
  });

  it('目录中没有的内置 id（同步来的新版本词书）是确定结果：多次调用不重取目录与文件；目录加载失败则下次重试', async () => {
    vi.resetModules();
    const store = await import('@/core/known/store');
    const fetched: string[] = [];
    let failIndex = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^.*?data\/books\//, '').replace(/\.json$/, '');
      fetched.push(path);
      if (path === 'index' && failIndex) return new Response('', { status: 500 });
      const body = path === 'index' ? CATALOG : FILES[path];
      return body ? new Response(JSON.stringify(body)) : new Response('', { status: 404 });
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settingsWith([], ['cet4', 'cefr-b1', 'future-book-v4']) });
    // 目录失败：本次没有内置熟词，但不缓存
    expect(await store.isKnownWord('abandon')).toBe(false);
    failIndex = false;
    expect(await store.isKnownWord('abandon')).toBe(true);
    const settled = fetched.length;
    expect(fetched.filter((p) => p === 'index')).toHaveLength(2);
    for (let i = 0; i < 3; i++) expect(await store.isKnownWord('travel')).toBe(true);
    // future-book-v4 不在目录中：不再请求目录与任何文件
    expect(fetched.length).toBe(settled);
    expect(fetched).not.toContain('future-book-v4');
    warn.mockRestore();
  });
});

describe('DefaultWordBookRegistry#loadAsKnown：ladder 补集文件并行请求', () => {
  it('base 与更低各档同时发出，不等更低各档返回', async () => {
    const pending = new Map<string, (f: BookDataFile) => void>();
    const loaders = memoryLoaders();
    loaders.book.mockImplementation((id: string) => new Promise<BookDataFile>((resolve) => pending.set(id, resolve)));
    const reg = new DefaultWordBookRegistry(loaders);
    const known = reg.loadAsKnown('cefr-b2');
    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(['cefr-a1', 'cefr-a2', 'cefr-b1']));
    for (const [id, resolve] of pending) resolve(FILES[id]!);
    expect(sorted((await known)!.words())).toEqual(['apple', 'argue', 'care', 'go', 'travel']);
  });
});

// ---------------- 选项页三态 setter ----------------

describe('setBookUsage / toggleBookUsage：生词本 / 熟词本 / 不用', () => {
  it('非 ladder 内置书两表互斥；已在目标表中不改变顺序', () => {
    const s = settingsWith(['gre', 'cet4'], []);
    setBookUsage(s, B['cet4']!, 'known', ALL);
    expect(s.books.enabled).toEqual(['gre']);
    expect(s.knownBooks.enabled).toEqual(['cet4']);
    expect(bookUsageOf(s, B['cet4']!)).toEqual({ new: false, known: true });
    setBookUsage(s, B['cet4']!, 'new', ALL);
    expect(s.books.enabled).toEqual(['gre', 'cet4']);
    expect(s.knownBooks.enabled).toEqual([]);
    setBookUsage(s, { ...B['gre']!, ...builtin(cat('gre')) }, 'new', ALL);
    expect(s.books.enabled).toEqual(['gre', 'cet4']);
    setBookUsage(s, B['cet4']!, 'off', ALL);
    expect(s.books.enabled).toEqual(['gre']);
  });

  it('ladder 书两表各自单选、互不影响：生词 B2+ 与熟词“B2 以下”可同时', () => {
    const s = settingsWith(['cefr-b1'], ['cefr-a2']);
    setBookUsage(s, B['cefr-b2']!, 'new', ALL);
    setBookUsage(s, B['cefr-b2']!, 'known', ALL);
    expect(s.books.enabled).toEqual(['cefr-b2']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2']);
    expect(bookUsageOf(s, B['cefr-b2']!)).toEqual({ new: true, known: true });
    // 只关熟词那一项
    toggleBookUsage(s, B['cefr-b2']!, 'known', ALL);
    expect(s.books.enabled).toEqual(['cefr-b2']);
    expect(s.knownBooks.enabled).toEqual([]);
  });

  it('group 书（计算机三档）两张表各自组内单选：可生词 cs-all + 熟词 cs-250，同一档不能两表同时', () => {
    const s = settingsWith(['cet4', 'cs-all'], ['cet6']);
    setBookUsage(s, B['cs-250']!, 'known', ALL);
    // 生词 cs-all 不受影响：效果 = 全部减去前 250
    expect([s.books.enabled, s.knownBooks.enabled]).toEqual([['cet4', 'cs-all'], ['cet6', 'cs-250']]);
    expect(bookUsageOf(s, B['cs-250']!)).toEqual({ new: false, known: true });
    expect(bookUsageOf(s, B['cs-all']!)).toEqual({ new: true, known: false });
    // 熟词本内组内单选：cs-500 替换 cs-250
    setBookUsage(s, B['cs-500']!, 'known', ALL);
    expect(s.knownBooks.enabled).toEqual(['cet6', 'cs-500']);
    // 同一档改作生词本：移出熟词本，同时替换生词本中的 cs-all（组内单选）
    setBookUsage(s, B['cs-500']!, 'new', ALL);
    expect([s.books.enabled, s.knownBooks.enabled]).toEqual([['cet4', 'cs-500'], ['cet6']]);
    // toggleBookUsage / 带元数据的 toggleBook 走同一口径
    toggleBookUsage(s, B['cs-250']!, 'known', ALL);
    expect([s.books.enabled, s.knownBooks.enabled]).toEqual([['cet4', 'cs-500'], ['cet6', 'cs-250']]);
    toggleBook(s, 'cs-250', true, ALL);
    expect([s.books.enabled, s.knownBooks.enabled]).toEqual([['cet4', 'cs-250'], ['cet6']]);
  });

  it('本地书作熟词本：移出生词本与生词类单词操作目标；“我的生词本”不能作熟词本', () => {
    const s = settingsWith(['local:a', MY_WORDS_BOOK_ID], []);
    s.wordActions.addTargets = [MY_WORDS_BOOK_ID, 'local:a'];
    s.wordActions.knownRemoveFrom = ['local:a'];
    expect(setBookUsage(s, LOCAL, 'known', ALL).removedTargets).toEqual(['加入生词本时写入', '标记熟词时移除']);
    expect(s.books.enabled).toEqual([MY_WORDS_BOOK_ID]);
    expect(s.knownBooks.enabled).toEqual(['local:a']);
    expect(s.wordActions.addTargets).toEqual([MY_WORDS_BOOK_ID]);
    expect(s.wordActions.knownRemoveFrom).toEqual([]);
    // 单词操作选项中置灰
    expect(wordActionOptions(s, ALL, []).addTargets.find((o) => o.id === 'local:a')).toMatchObject({ disabled: true });
    expect(canUseAsKnown(MINE)).toBe(false);
    setBookUsage(s, MINE, 'known', ALL);
    expect(s.knownBooks.enabled).toEqual(['local:a']);
    expect(s.books.enabled).toEqual([MY_WORDS_BOOK_ID]);
  });

  it('来源书委托 setSourceBookRole；off 只移出两表、角色不变', () => {
    const s = settingsWith([EU1.id], []);
    s.wordActions.addTargets = [EU1.id];
    expect(setBookUsage(s, EU1, 'known', ALL).removedTargets).toEqual(['加入生词本时写入']);
    expect(s.knownBooks.roles[EU1.id]).toBe('known');
    expect(s.knownBooks.enabled).toEqual([EU1.id]);
    expect(s.books.enabled).toEqual([]);
    // 点亮着的“熟词”= 停用该熟词本，角色仍为 known
    toggleBookUsage(s, { ...EU1, sync: EU1.sync }, 'known', ALL);
    expect(s.knownBooks.enabled).toEqual([]);
    expect(s.knownBooks.roles[EU1.id]).toBe('known');
    toggleBookUsage(s, EU1, 'new', ALL);
    expect(s.knownBooks.roles[EU1.id]).toBeUndefined();
    expect(s.books.enabled).toEqual([EU1.id]);
  });

  it('整行点击（toggleBook）启用为生词本时也保持互斥', () => {
    const s = settingsWith([], ['cet4']);
    toggleBook(s, 'cet4', undefined, ALL);
    expect(s.books.enabled).toEqual(['cet4']);
    expect(s.knownBooks.enabled).toEqual([]);
    toggleBook(s, 'cet4', undefined, ALL);
    expect(s.books.enabled).toEqual([]);
  });

  it('toggleBook 不传元数据（“全选”、用户词书整行点击、本地书删除）也保持互斥，不留失效 id', () => {
    // 复现：cet4 已作熟词本，元数据缺省时启用为生词本 -> 必须移出熟词本，否则之后停用生词时会悄悄恢复成熟词本
    const s = settingsWith(['cet6'], ['cet4', 'local:a', EU1.id]);
    toggleBook(s, 'cet4', true);
    expect(s.books.enabled).toEqual(['cet6', 'cet4']);
    expect(s.knownBooks.enabled).toEqual(['local:a', EU1.id]);
    toggleBook(s, 'cet4', false);
    expect(s.knownBooks.enabled).toEqual(['local:a', EU1.id]);
    // 本地书启用为生词本：移出熟词本
    toggleBook(s, 'local:a', true);
    expect(s.knownBooks.enabled).toEqual([EU1.id]);
    // 本地书删除（LocalBooksSection 只调 toggleBook 停用）：熟词本中的 id 一并清掉
    s.knownBooks.enabled = ['local:b', EU1.id];
    toggleBook(s, 'local:b', false);
    expect(s.knownBooks.enabled).toEqual([EU1.id]);
    // 来源书的熟词本由角色决定，这里不动
    toggleBook(s, EU1.id, true);
    expect(s.knownBooks.enabled).toEqual([EU1.id]);
  });
});

describe('全选：单选组只取一档', () => {
  /** 专业领域组：普通书 + 计算机三档（嵌套“前 N”，group 单选）+ 一本增量书 */
  const DOMAIN: BookMeta[] = [
    builtin(cat('nawl', { category: 'domain', size: 944 })),
    builtin(cat('bsl', { category: 'domain', size: 1700 })),
    builtin(cat('cs-250', { category: 'domain', group: 'cs', size: 194 })),
    builtin(cat('cs-500', { category: 'domain', group: 'cs', size: 334 })),
    builtin(cat('cs-all', { category: 'domain', group: 'cs', size: 472 })),
    builtin(cat('bsl-new', { category: 'domain', size: 100, delta: { of: 'bsl', minus: [] } })),
  ];

  it('selectAllIds：去掉增量书，单选组只取词数最多的一档', () => {
    expect(selectAllIds(DOMAIN)).toEqual(['nawl', 'bsl', 'cs-all']);
  });

  it('逐本 toggleBook 全选（当前词书页写法，不传元数据）后仍组内单选，全选框能勾上', () => {
    const s = settingsWith([], ['nawl']);
    for (const id of selectAllIds(DOMAIN)) toggleBook(s, id, true);
    expect(s.books.enabled).toEqual(['nawl', 'bsl', 'cs-all']);
    expect(s.knownBooks.enabled).toEqual([]);
    expect(selectAllIds(DOMAIN).every((id) => s.books.enabled.includes(id))).toBe(true);
  });

  it('词书页逐本全选（不传元数据）：内置书用打包目录元数据，已选 cs-250 时全选专业领域只留 cs-all', () => {
    // 复现（critic r4）：books.enabled=['cs-250'] 时点专业领域全选，旧实现得到 ['cs-250','cs-all']，组内单选被破坏
    const s = settingsWith(['cs-250'], []);
    for (const id of selectAllIds(DOMAIN)) toggleBook(s, id, true);
    expect(s.books.enabled).toEqual(['nawl', 'bsl', 'cs-all']);
  });

  it('toggleBook 不传元数据：group 书只与自身跨表互斥、ladder 书两表可同时（打包目录元数据）', () => {
    const s = settingsWith([], ['cs-500', 'cefr-b2', 'gk']);
    toggleBook(s, 'cs-all', true);
    expect(s.knownBooks.enabled).toEqual(['cs-500', 'cefr-b2', 'gk']);
    toggleBook(s, 'cs-500', true);
    expect(s.books.enabled).toEqual(['cs-500']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', 'gk']);
    toggleBook(s, 'cs-500', false);
    toggleBook(s, 'cs-250', true);
    toggleBook(s, 'cefr-b2', true);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', 'gk']);
    toggleBook(s, 'cefr-b1', true);
    // 同 ladder 组内单选：B1 替换 B2（生词本），熟词本中的 cefr-b2 不受影响
    expect(s.books.enabled).toEqual(['cs-250', 'cefr-b1']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', 'gk']);
  });

  it('toggleAllBooks：带元数据全选会替换组内已选的另一档；全不选只停用生词本用法', () => {
    const s = settingsWith(['cs-250', 'cefr-b2'], ['cefr-b2']);
    expect(toggleAllBooks(s, DOMAIN, true).skippedKnown).toEqual([]);
    expect(s.books.enabled).toEqual(['cefr-b2', 'nawl', 'bsl', 'cs-all']);
    expect(allBooksSelected(s, DOMAIN)).toBe(true);
    toggleAllBooks(s, DOMAIN, false);
    expect(s.books.enabled).toEqual(['cefr-b2']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2']);
  });

  it('toggleAllBooks 全选跳过作熟词本的书（不悄悄改用途），单选组选中的一档作熟词本时整组跳过', () => {
    const local = { ...LOCAL, category: 'domain' as const };
    const list = [...DOMAIN, local];
    const s = settingsWith([], ['nawl', 'cs-all', 'local:a']);
    const { skippedKnown } = toggleAllBooks(s, list, true);
    expect(skippedKnown.map((b) => b.id)).toEqual(['nawl', 'cs-all', 'local:a']);
    expect(s.books.enabled).toEqual(['bsl']);
    expect(s.knownBooks.enabled).toEqual(['nawl', 'cs-all', 'local:a']);
    // 跳过的书不影响全选框：可启用的都已启用即为勾选
    expect(allBooksSelected(s, list)).toBe(true);
    // 熟词角色的来源书即使不在 knownBooks.enabled 中也跳过（启用为生词本会改它的角色）
    const s2 = settingsWith([], []);
    expect(toggleAllBooks(s2, [MASTERED], true).skippedKnown).toEqual([MASTERED]);
    expect(s2.books.enabled).toEqual([]);
    expect(s2.knownBooks.roles).toEqual({});
    expect(allBooksSelected(s2, [MASTERED])).toBe(false);
  });

  it('toggleAllBooks 全不选只撤生词本用法：本地书、ladder 书的熟词本用法都不动', () => {
    const local = { ...LOCAL, category: 'domain' as const };
    const s = settingsWith(['bsl', 'local:b', 'cs-all', 'cet4'], ['local:a', 'cs-250', 'cefr-b2']);
    const localB = { ...LOCAL, id: 'local:b', category: 'domain' as const };
    toggleAllBooks(s, [...DOMAIN, local, localB, B['cefr-b2']!], false);
    expect(s.books.enabled).toEqual(['cet4']);
    expect(s.knownBooks.enabled).toEqual(['local:a', 'cs-250', 'cefr-b2']);
  });
});

describe('词书页搜索与筛选、分组', () => {
  it('bookMatchesQuery：归一化去空格/连字符、大小写不敏感，匹配 keywords、knownName、来源与文件名', () => {
    const cet6 = builtin(cat('cet6', { name: '大学英语六级', nameEn: 'CET-6', short: '六级', keywords: ['六级', 'cet-6', 'college english'] }));
    expect(bookMatchesQuery(cet6, 'CET 6')).toBe(true);
    expect(bookMatchesQuery(cet6, 'cet6')).toBe(true);
    expect(bookMatchesQuery(cet6, 'College-English')).toBe(true);
    expect(bookMatchesQuery(cet6, '雅思')).toBe(false);
    expect(bookMatchesQuery(cet6, '  ')).toBe(true);
    expect(bookMatchesQuery(B['cefr-b2']!, 'B1（B2')).toBe(true);
    expect(bookMatchesQuery(LOCAL, '托福核心.txt')).toBe(true);
    expect(bookMatchesQuery(MASTERED, '欧路')).toBe(true);
    const ngsl = builtin(cat('ngsl', { license: 'CC BY-SA 4.0', source: 'NGSL Project' }));
    expect(bookMatchesQuery(ngsl, 'cc by-sa')).toBe(true);
  });

  it('matchesUsageFilter 与 hasLadderBooks', () => {
    const s = settingsWith(['cet4'], ['cs-250']);
    expect(matchesUsageFilter(s, B['cet4']!, 'new')).toBe(true);
    expect(matchesUsageFilter(s, B['cs-250']!, 'known')).toBe(true);
    expect(matchesUsageFilter(s, B['cefr-b2']!, 'unused')).toBe(true);
    expect(matchesUsageFilter(s, B['cet4']!, 'unused')).toBe(false);
    expect(hasLadderBooks([B['cefr-b2']!])).toBe(true);
    expect(hasLadderBooks([B['cs-250']!, B['cet4']!])).toBe(false);
  });

  it('分组包含通用核心词与专业领域（选项页、popup）', () => {
    expect(CATEGORY_GROUPS.map((g) => g.category)).toEqual(['level', 'exam', 'frequency', 'core', 'domain', 'other']);
    const groups = groupBooks([builtin(cat('nawl', { category: 'domain' })), builtin(cat('ngsl', { category: 'core' })), B['cet4']!]);
    expect(groups.map((g) => [g.category, g.title])).toEqual([
      ['exam', '考试分级'],
      ['core', '通用核心词'],
      ['domain', '专业领域'],
    ]);
  });

  it('popup newBookChoices 过滤仅作熟词本的书，保留 ladder 书', () => {
    const s = settingsWith(['cet4'], ['cs-250', 'cefr-b2', MASTERED.id]);
    const ids = newBookChoices(s, ALL).map((b) => b.id);
    expect(ids).not.toContain('cs-250');
    expect(ids).not.toContain(MASTERED.id);
    expect(ids).toContain('cefr-b2');
    expect(ids).toContain('cet4');
  });

  it('group 书：popup 只隐藏真正作熟词本的那一档；同一档两表同时（冲突状态）读取时生词本优先', () => {
    const s = settingsWith(['cet4'], ['cs-250']);
    const ids = newBookChoices(s, ALL).map((b) => b.id);
    expect(ids).not.toContain('cs-250');
    expect(ids).toEqual(expect.arrayContaining(['cs-500', 'cs-all']));
    expect(isKnownOnlyBook(s, B['cs-500']!)).toBe(false);
    // 生词 cs-all + 熟词 cs-250：两本都生效
    const both = settingsWith(['cs-all'], ['cs-250']);
    expect(enabledKnownBookIds(both, ALL)).toEqual(['cs-250']);
    // 同步来的旧设置等造成的冲突状态：同一档同时在两张表 -> 熟词不生效，popup 仍可开关
    const conflict = settingsWith(['cs-500'], ['cs-500']);
    expect(isEffectiveKnownBook(conflict, B['cs-500']!)).toBe(false);
    expect(bookUsageOf(conflict, B['cs-500']!)).toEqual({ new: true, known: false });
    expect(enabledKnownBookIds(conflict, ALL)).toEqual([]);
    expect(newBookChoices(conflict, ALL).map((b) => b.id)).toContain('cs-500');
  });

  it('setNewBookEnabled（popup / 悬浮球生词开关）：启用为生词本时维护跨表互斥，不留读取时失效的熟词本 id', () => {
    const s = settingsWith(['cet4'], ['cs-500', 'cefr-b2', 'local:a', MASTERED.id]);
    // group 书：同组其它档作熟词本不受影响（生词 cs-all + 熟词 cs-500）
    setNewBookEnabled(s, 'cs-all', true, ALL);
    expect(s.knownBooks.enabled).toEqual(['cs-500', 'cefr-b2', 'local:a', MASTERED.id]);
    // 同一档启用为生词本：只把自身移出熟词本（生词本组内单选替换 cs-all）
    setNewBookEnabled(s, 'cs-500', true, ALL);
    setNewBookEnabled(s, 'cs-250', true, ALL);
    expect(s.books.enabled).toEqual(['cet4', 'cs-250']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', 'local:a', MASTERED.id]);
    // ladder 书：两表可同时；生词本内组内单选
    setNewBookEnabled(s, 'cefr-b2', true, ALL);
    setNewBookEnabled(s, 'cefr-b1', true, ALL);
    expect(s.books.enabled).toEqual(['cet4', 'cs-250', 'cefr-b1']);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', 'local:a', MASTERED.id]);
    // 本地书：移出熟词本；来源书的熟词本由角色决定，不动
    setNewBookEnabled(s, 'local:a', true, ALL);
    setNewBookEnabled(s, MASTERED.id, true, ALL);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', MASTERED.id]);
    // 停用只改生词本
    setNewBookEnabled(s, 'cs-250', false, ALL);
    expect(s.books.enabled).toEqual(['cet4', 'cefr-b1', 'local:a', MASTERED.id]);
    expect(s.knownBooks.enabled).toEqual(['cefr-b2', MASTERED.id]);
  });

  it('getKnownWordSets：group 书生词、熟词各一档时熟词照常生效；同一档两表同时按生词本', async () => {
    fakeBrowser.reset();
    const reg = new DefaultWordBookRegistry(memoryLoaders());
    const sets = await getKnownWordSets(reg, settingsWith(['cs-all'], ['cs-250']));
    expect(sorted(sets.builtin)).toEqual(['algorithm']);
    // 效果 = 全部减去前 250：前 250 的词不高亮，其余照常
    const csAll = (await reg.load('cs-all'))!;
    const m = new WordMatcher({ lemmatizer: { candidates: (w) => [w] }, books: [csAll], known: sets.words, knownBuiltin: sets.builtin });
    expect(m.match('algorithm')).toBeNull();
    expect(m.match('tuple')?.bookIds).toEqual(['cs-all']);
    expect((await getKnownWordSets(reg, settingsWith(['cs-500'], ['cs-500']))).builtin.size).toBe(0);
    expect(sorted((await getKnownWordSets(reg, settingsWith(['cet4'], ['cs-500']))).builtin)).toEqual(['algorithm', 'compiler']);
  });
});

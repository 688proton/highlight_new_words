import { MY_WORDS_BOOK_ID, type BookId } from '../settings/schema';
import { fetchPackagedJson } from '../dict/packaged';
import { getProviderInfo } from '../source/providers';
import { parseBookId } from './ids';
import type {
  BookCatalog,
  BookDataFile,
  BookMeta,
  CatalogBookMeta,
  LocalBookData,
  LocalBookIndex,
  LocalBookMeta,
  SourceBookData,
  SourceBookIndex,
  SourceBookState,
  WordBook,
  WordBookRegistry,
} from './types';
import { createUserWordBook } from './user-book';
import { getLocalBook, getLocalIndex, getSourceBook, getSourceIndex } from './user-store';

/** 注册表数据加载器：抽象出来便于单测注入内存数据 */
export interface RegistryLoaders {
  catalog(): Promise<BookCatalog>;
  book(id: BookId): Promise<BookDataFile>;
  sourceIndex(): Promise<SourceBookIndex>;
  sourceBook(id: BookId): Promise<SourceBookData | undefined>;
  localIndex(): Promise<LocalBookIndex>;
  localBook(id: BookId): Promise<LocalBookData | undefined>;
}

/** 由 Set 构造 WordBook */
export function createSetWordBook(meta: BookMeta, words: Iterable<string>): WordBook {
  const set = new Set<string>();
  for (const w of words) set.add(w.toLowerCase());
  return { meta: { ...meta, size: set.size }, has: (w) => set.has(w), size: set.size, words: () => set };
}

/** 来源词书元数据：名称为“来源名 · 远端生词本名” */
export function sourceBookMeta(state: SourceBookState): BookMeta {
  const provider = getProviderInfo(state.providerId)?.name ?? state.providerId;
  return {
    id: state.id,
    kind: 'source',
    name: `${provider} · ${state.name}`,
    nameEn: state.name,
    // 短标签（popup 本页生词的来源标签）：名称太长时用来源名（“欧路”），不用泛称“生词本”，避免与本地“我的生词本”混淆
    short: state.name.length <= 4 ? state.name : provider.replace(/词典$/, ''),
    category: 'user',
    level: 0,
    size: state.wordCount,
    source: provider,
    providerId: state.providerId,
    remoteId: state.remoteId,
    sync: state,
    updatedAt: state.lastSyncAt || undefined,
  };
}

/** 本地导入词书元数据 */
export function localBookMeta(meta: LocalBookMeta): BookMeta {
  return {
    id: meta.id,
    kind: 'local',
    name: meta.name,
    nameEn: meta.name,
    // “我的生词本”是卡片加词时自动创建的，不是导入的，短标签用“本地”
    short: meta.id === MY_WORDS_BOOK_ID ? '本地' : meta.name.length <= 4 ? meta.name : '导入',
    category: 'user',
    level: 1,
    size: meta.wordCount,
    source: meta.fileName ? `导入自 ${meta.fileName}` : '手动导入',
    importFormat: meta.format,
    updatedAt: meta.updatedAt,
  };
}

/** 目录加载失败时 registry 内部使用的空目录（按对象身份识别，见 DefaultWordBookRegistry#catalog） */
const FAILED_CATALOG: BookCatalog = Object.freeze({ version: 0, books: [] });

function builtinMeta(meta: CatalogBookMeta): BookMeta {
  return { ...meta, kind: 'builtin' };
}

/**
 * 默认词书注册表：统一管理三类词书（id 规则见 ids.ts）。
 * - 内置：扩展包 data/books/ 懒加载（每本书一个文件）
 * - 来源 / 本地导入：storage 索引 + 每本书一个数据键
 * 加载结果按 id 缓存（加载出错的不缓存，下次重试）；用户词书数据变化后调用方新建 registry（内容脚本在 storage 变化时整体重建）。
 */
export class DefaultWordBookRegistry implements WordBookRegistry {
  private catalogPromise?: Promise<BookCatalog>;
  private cache = new Map<BookId, Promise<WordBook | undefined>>();
  /** loadAsKnown 的结果缓存（ladder 书作熟词本是补集，与 load 的同 id 结果不同，单独缓存） */
  private knownCache = new Map<BookId, Promise<WordBook | undefined>>();
  /** 内置词书数据文件缓存：同时启用 B2 与 C1 时，被 extends 共享的 cefr-c2 等文件只加载一次 */
  private bookFiles = new Map<BookId, Promise<BookDataFile>>();

  constructor(private readonly loaders: RegistryLoaders) {}

  /**
   * 词书目录：失败时本次按空目录处理（list 不报错），并清掉缓存让下次调用重新请求；
   * 返回的是固定的 FAILED_CATALOG，按 id 查内置书时据此抛错（见 builtinCatalogMeta），避免把“目录没取到”缓存成“没有这本书”。
   */
  private catalog(): Promise<BookCatalog> {
    this.catalogPromise ??= this.loaders.catalog().catch((e) => {
      console.warn('[hnw] 词书目录加载失败', e);
      this.catalogPromise = undefined;
      return FAILED_CATALOG;
    });
    return this.catalogPromise;
  }

  /**
   * 内置书的目录元数据与目录本身：目录中确实没有该 id 时返回 meta 为 undefined（确定结果，会被 load/loadAsKnown 缓存，
   * 如同步过来的新版本词书、目录已删除的旧书）；目录加载失败时抛错（不缓存，下次重试）
   */
  private async builtinCatalogMeta(id: BookId): Promise<{ catalog: BookCatalog; meta: CatalogBookMeta | undefined }> {
    const catalog = await this.catalog();
    if (catalog === FAILED_CATALOG) throw new Error('词书目录加载失败');
    return { catalog, meta: catalog.books.find((b) => b.id === id) };
  }

  async list(): Promise<BookMeta[]> {
    const [catalog, sources, locals] = await Promise.all([this.catalog(), this.loaders.sourceIndex(), this.loaders.localIndex()]);
    return [
      ...Object.values(sources.books).map(sourceBookMeta),
      ...Object.values(locals.books)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(localBookMeta),
      ...catalog.books.map(builtinMeta),
    ];
  }

  load(id: BookId): Promise<WordBook | undefined> {
    return this.cached(this.cache, id, () => this.loadUncached(id)).catch((e) => {
      console.warn('[hnw] 词书加载失败', id, e);
      return undefined;
    });
  }

  loadAsKnown(id: BookId): Promise<WordBook | undefined> {
    return this.cached(this.knownCache, id, () => this.loadAsKnownUncached(id)).catch((e) => {
      console.warn('[hnw] 熟词本加载失败', id, e);
      return undefined;
    });
  }

  /**
   * 按 id 缓存加载结果（缓存的是未吞错的 promise，loadAsKnown 复用 load 的结果时能感知到出错）：
   * 加载出错（网络/文件读取失败、目录没取到）不缓存，下次调用重试——background 共享实例靠这一点只重取失败的书；
   * “没有这本书”是确定结果（resolve 为 undefined），照常缓存。
   */
  private cached(map: Map<BookId, Promise<WordBook | undefined>>, id: BookId, loader: () => Promise<WordBook | undefined>): Promise<WordBook | undefined> {
    let p = map.get(id);
    if (!p) {
      const created = loader();
      created.catch(() => {
        if (map.get(id) === created) map.delete(id);
      });
      map.set(id, created);
      p = created;
    }
    return p;
  }

  /**
   * 作熟词本加载：只有内置 ladder 书语义不同——作生词本是“本档及以上”，作熟词本是“低于本档”（两集合不相交，
   * 所以同一档可以同时作生词本和熟词本）。补集 = ladder base 文件 ∪ 同 ladder 中 level 更低各档文件自身的 words
   * （不沿 extends 往上合并，extends 指向的是更高档）。其它书（考试书、group 书、用户词书）就是书本身。
   */
  private async loadAsKnownUncached(id: BookId): Promise<WordBook | undefined> {
    // 其它书等同 load：取 load 的缓存（未吞错版本，出错时本书的熟词结果也不缓存）
    const asBook = () => this.cached(this.cache, id, () => this.loadUncached(id));
    if (parseBookId(id).kind !== 'builtin') return asBook();
    const { catalog, meta } = await this.builtinCatalogMeta(id);
    if (!meta) return undefined;
    if (!meta.ladder) return asBook();
    const [baseId, ...lowerIds] = ladderComplementFileIds(catalog, meta);
    // base 与更低各档同时请求（都只依赖目录，互不依赖）；
    // base 文件缺失（数据未生成或加载失败）时退化为只取更低各档，不让整本熟词本失效
    const [base, ...lower] = await Promise.all([
      baseId
        ? this.bookFile(baseId).catch((e) => {
            console.warn('[hnw] ladder base 文件加载失败', baseId, e);
            return undefined;
          })
        : undefined,
      ...lowerIds.map((b) => this.bookFile(b)),
    ]);
    const words = [...(base?.words ?? []), ...lower.flatMap((f) => f?.words ?? [])];
    return createSetWordBook({ ...builtinMeta(meta), name: meta.knownName ?? meta.name }, words);
  }

  /** 内置词书数据文件（按 id 缓存，load 与 loadAsKnown 共用） */
  private bookFile(id: BookId): Promise<BookDataFile> {
    let file = this.bookFiles.get(id);
    if (!file) {
      file = this.loaders.book(id);
      // 失败的请求不留在缓存里，下次重新请求（否则一次网络错误会让这个文件永久失效）
      file.catch(() => this.bookFiles.delete(id));
      this.bookFiles.set(id, file);
    }
    return file;
  }

  private async loadUncached(id: BookId): Promise<WordBook | undefined> {
    const parsed = parseBookId(id);
    if (parsed.kind === 'source') {
      const [index, data] = await Promise.all([this.loaders.sourceIndex(), this.loaders.sourceBook(id)]);
      const state = index.books[id];
      return state && data ? createUserWordBook(sourceBookMeta(state), data.words) : undefined;
    }
    if (parsed.kind === 'local') {
      const [index, data] = await Promise.all([this.loaders.localIndex(), this.loaders.localBook(id)]);
      const meta = index.books[id];
      return meta && data ? createUserWordBook(localBookMeta(meta), data.words) : undefined;
    }
    const { meta } = await this.builtinCatalogMeta(id);
    if (!meta) return undefined;
    return createSetWordBook(builtinMeta(meta), await this.builtinWords(id, new Set()));
  }

  /**
   * 内置词书的全部词：本文件 words + 递归合并 extends 指向的词书文件（级别/词频书是包含关系，只存差集）。
   * extends 指向的书即使不在 catalog 中也按文件加载；visiting 防止数据错误导致的循环引用。
   */
  private async builtinWords(id: BookId, visiting: Set<BookId>): Promise<string[]> {
    if (visiting.has(id)) return [];
    visiting.add(id);
    const data = await this.bookFile(id);
    if (!data.extends?.length) return data.words;
    const parents = await Promise.all(data.extends.map((p) => this.builtinWords(p, visiting)));
    return [...data.words, ...parents.flat()];
  }
}

/**
 * ladder 书作熟词本（“低于本档”）需要的数据文件：首项为 ladder base 文件 id（未声明时为 null），其后为同 ladder 中 level 更低的各档。
 * 非 ladder 书返回 [null]（无需额外文件）。content 首屏预取与 registry 求补集共用。
 */
export function ladderComplementFileIds(catalog: Pick<BookCatalog, 'books' | 'ladders'>, meta: Pick<CatalogBookMeta, 'ladder' | 'level'>): [BookId | null, ...BookId[]] {
  if (!meta.ladder) return [null];
  const lower = catalog.books.filter((b) => b.ladder === meta.ladder && b.level < meta.level).map((b) => b.id);
  return [catalog.ladders?.[meta.ladder]?.base ?? null, ...lower];
}

/**
 * 作熟词本加载某本内置书需要的全部数据文件 id（预取用）：ladder 书为 base + 更低各档，其它书为本书（extends 加载时再取）。
 * 不在 catalog 中的 id 返回空数组。
 */
export function knownBookFileIds(catalog: Pick<BookCatalog, 'books' | 'ladders'>, id: BookId): BookId[] {
  const meta = catalog.books.find((b) => b.id === id);
  if (!meta) return [];
  if (!meta.ladder) return [id];
  return ladderComplementFileIds(catalog, meta).filter((b): b is BookId => !!b);
}

/** 扩展运行时使用的 loaders（任意上下文可用：内置词书 fetch 扩展包，用户词书读 storage.local） */
export function createExtensionLoaders(): RegistryLoaders {
  return {
    catalog: () => fetchPackagedJson<BookCatalog>('data/books/index.json'),
    book: (id) => fetchPackagedJson<BookDataFile>(`data/books/${id}.json`),
    sourceIndex: getSourceIndex,
    sourceBook: getSourceBook,
    localIndex: getLocalIndex,
    localBook: getLocalBook,
  };
}

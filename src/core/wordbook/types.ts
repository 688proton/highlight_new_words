import type { BookId } from '../settings/schema';
import type { ImportFormat } from '../import/types';
import type { BookKind } from './ids';
import type { BookRole } from '../settings/schema';

export type { BookKind } from './ids';

/**
 * 词书契约。
 *
 * 词书只负责“哪些词（原形/小写）属于这本书”，释义由 Dictionary 负责（core/dict）。
 * 内置词书 word 均为小写原形（lemma）；用户词书（来源/本地导入）的 key 是用户收录的小写原词，可能是变形词，
 * 匹配时 Lemmatizer 候选首项为原词本身，所以变形词也能直接命中。
 *
 * 三类词书统一由 WordBookRegistry 管理，id 规则见 ids.ts。
 */

/**
 * 词书分类：user 用户词书；level CEFR 风格级别（包含体系：选 B2 = B2+C1+C2）；exam 考试（含“增量”书，见 delta）；
 * frequency 词频（COCA 前 N 之外）；core 通用核心词（NGSL 等）；domain 专业领域（学术科研/商务/职场/医学/计算机）；other 其他。
 * 新增分类时需补全按分类穷举的 Record（如 popup/model.ts 的分类标题）。
 */
export type BookCategory = 'user' | 'level' | 'exam' | 'frequency' | 'core' | 'domain' | 'other';

/** 内置词书目录（data/books/index.json）中的元数据，由 data 分片生成 */
export interface CatalogBookMeta {
  id: BookId;
  /** 中文名，如“大学英语六级” */
  name: string;
  nameEn: string;
  /** 简称，用于卡片上的小标签，如“六级” */
  short: string;
  category: BookCategory;
  /** 同类中的难度/排序，数值越大越难 */
  level: number;
  /** 词数（catalog 中记录，便于 UI 展示，不必加载数据） */
  size: number;
  /** 数据来源说明，如 “ECDICT (MIT)” */
  source?: string;
  description?: string;
  /** 为 true 表示当前是占位样例数据（foundation 阶段），data 分片替换真实数据后移除 */
  placeholder?: boolean;
  /** 增量词书：本书 = of 书 − minus 各书（如六级新增 = 六级 − 中考/高考/四级），UI 可标“增量” */
  delta?: { of: BookId; minus: BookId[] };
  /**
   * 包含体系组键（level 书为 'cefr'，frequency 书为 'coca'）：同组单选；
   * 作生词本 = 本档及以上（本书全部词），作熟词本 = 低于本档（ladder base 文件 ∪ 同组更低各档自身词，见 BookCatalog.ladders）
   */
  ladder?: string;
  /** 组内单选但不是包含体系的组键（如计算机三档 'cs'，三档是嵌套的“前 N”集合）：作熟词本时就是本书自身 */
  group?: string;
  /** 作熟词本时的显示名（ladder 书取补集，如 cefr-b2 为“A1–B1（B2 以下）”） */
  knownName?: string;
  /** 数据许可，如 'CC BY-SA 4.0'（相同方式共享类许可需在界面展示） */
  license?: string;
  /** 数据来源链接 */
  url?: string;
  /** 搜索别名（中英都有，如 cet6 配“六级”“cet-6”） */
  keywords?: string[];
}

/**
 * Registry 对外的词书元数据（三类统一）。
 * 用户词书（source/local）的 category 固定为 'user'，size 为当前本地缓存词数。
 */
export interface BookMeta extends CatalogBookMeta {
  kind: BookKind;
  /** kind=source：来源 provider id 与远端生词本 id */
  providerId?: string;
  remoteId?: string;
  /** kind=source：同步状态（与 storage `sourceBooks` 索引一致） */
  sync?: SourceBookState;
  /** kind=local：导入格式与时间 */
  importFormat?: ImportFormat;
  /** 用户词书最近更新时间（同步/导入） */
  updatedAt?: number;
}

/** 已加载的词书 */
export interface WordBook {
  meta: BookMeta;
  /** word 为小写 */
  has(word: string): boolean;
  readonly size: number;
  words(): Iterable<string>;
  /** 用户词书（source/local）可提供自带的音标/释义；内置词书不实现 */
  entry?(word: string): UserWord | undefined;
}

/**
 * 词书注册表：列出可用词书并按需（懒）加载。
 * - 内置词书：打包在扩展的 public/data/books/ 下，catalog 为 data/books/index.json
 * - 来源词书：storage `sourceBooks` 索引 + `srcBook:<id>` 数据
 * - 本地导入词书：storage `localBooks` 索引 + `localBook:<id>` 数据
 */
export interface WordBookRegistry {
  /** 全部可用词书：用户词书（来源、本地）在前，内置词书在后 */
  list(): Promise<BookMeta[]>;
  /** 加载词书；同一 id 多次调用返回同一缓存实例；未知 id 或无数据返回 undefined */
  load(id: BookId): Promise<WordBook | undefined>;
  /**
   * 按“作熟词本”的语义加载词书：ladder 书返回“低于本档”的补集，其它书等同 load。
   * 结果单独缓存（与 load 的同 id 结果不同）。
   */
  loadAsKnown(id: BookId): Promise<WordBook | undefined>;
}

/** 包含体系（ladder）的声明 */
export interface BookLadder {
  /** 最底层 base 文件 id（BookDataFile 格式，不进 books 列表）：如 cefr 的 A1 段、coca 的前 3000；没有最底层文件时为 null */
  base: BookId | null;
}

/** data/books/index.json 结构 */
export interface BookCatalog {
  version: number;
  books: CatalogBookMeta[];
  /** 包含体系组键 -> 声明（cefr -> cefr-a1、coca -> coca-top），作熟词本求补集时使用 */
  ladders?: Record<string, BookLadder>;
}

/**
 * data/books/<id>.json 结构：words 为小写原形数组（已排序）。
 * 嵌套词书（级别、词频为包含关系）只存比 extends 多出的词，registry 加载时递归合并 extends 中各书的词。
 */
export interface BookDataFile {
  id: BookId;
  words: string[];
  extends?: BookId[];
}

// ---------------- 用户词书（来源 / 本地导入）共用 ----------------

/** 用户词书中的单个词条（各来源、各导入格式规范化后的结构） */
export interface UserWord {
  /** 原始单词（保留大小写） */
  word: string;
  phonetic?: string;
  /** 释义（原文，可能含 HTML 片段/换行，展示前用 userWordToEntry 清洗） */
  trans?: string;
  /** provider 删除远端词条所需的句柄（有道为 itemId；欧路为远端单词原文），本地导入词书不填 */
  ref?: string;
  /**
   * 同一规范化单词在远端有多个条目时的全部删除句柄（含 ref），如有道同时收录 Collapse 与 collapse 两个 itemId。
   * 删除时必须逐个删除，全部成功才算删除成功（background 第 2 轮新增，旧缓存没有该字段时只用 ref）。
   */
  refs?: string[];
}

/** 词条表：key 为小写单词 */
export type UserWordMap = Record<string, UserWord>;

// ---------------- 来源词书 ----------------

/** 来源词书同步状态：never=已发现未同步 / syncing / ok / empty=同步成功但为空 / error */
export type SourceSyncStatus = 'never' | 'syncing' | 'ok' | 'empty' | 'error';

/** 来源词书的同步元数据（storage `sourceBooks` 索引中的一项；体积小，UI 直接读取展示） */
export interface SourceBookState {
  id: BookId;
  providerId: string;
  remoteId: string;
  /** 远端生词本名称（如欧路分类名） */
  name: string;
  status: SourceSyncStatus;
  /** 上次成功同步时间 ms，0=从未 */
  lastSyncAt: number;
  /** 上次尝试同步时间 ms */
  lastAttemptAt: number;
  /** 本地缓存词数 */
  wordCount: number;
  /** 最近一次失败的提示文案（成功后清空） */
  error?: string;
  /** 远端已不存在该生词本（listRemoteBooks 不再返回），本地缓存保留，由用户决定删除 */
  orphaned?: boolean;
  /**
   * provider 声明的角色（默认 new）：known 表示远端熟词本（如欧路“已掌握”），同步后作为熟词来源而不是高亮词书。
   * 实际生效角色还要看用户覆盖 settings.knownBooks.roles，用 effectiveBookRole 计算。
   */
  role?: BookRole;
  /** 该远端生词本能否加词（provider.addWords 可写入该本；有道只能写入默认分组，欧路“已掌握”只读） */
  canAdd?: boolean;
  /** 该远端生词本能否删词（缺省按 provider.capabilities.delete） */
  canDelete?: boolean;
  /** 不能加/删时给用户看的原因（如“欧路 OpenAPI 未提供写入已掌握单词的接口”） */
  readOnlyReason?: string;
  /** 远端条目数（大小写不同的同一单词各算一条，与网页显示一致）；与 wordCount 不同时 UI 可提示“含 N 个重复条目” */
  entryCount?: number;
}

/** storage `sourceBooks` 键：所有来源词书的索引 + 各 provider 的列表刷新状态 */
export interface SourceBookIndex {
  books: Record<BookId, SourceBookState>;
  providers: Record<string, { lastListAt: number; error?: string }>;
}

/** storage `srcBook:<id>` 键：单本来源词书数据 */
export interface SourceBookData {
  id: BookId;
  words: UserWordMap;
  updatedAt: number;
}

// ---------------- 本地导入词书 ----------------

/** 本地词书元数据（storage `localBooks` 索引中的一项） */
export interface LocalBookMeta {
  id: BookId;
  /** 用户可重命名 */
  name: string;
  format: ImportFormat;
  /** 导入时的文件名，仅展示 */
  fileName?: string;
  wordCount: number;
  createdAt: number;
  /** 内容或名称最近修改时间；多设备同步按此做 LWW */
  updatedAt: number;
}

/** storage `localBooks` 键：本地词书索引 + 删除墓碑（多设备同步时避免已删除的书被“复活”） */
export interface LocalBookIndex {
  books: Record<BookId, LocalBookMeta>;
  /** id -> 删除时间 ms */
  removed: Record<BookId, number>;
}

/** storage `localBook:<id>` 键：单本本地词书数据 */
export interface LocalBookData {
  id: BookId;
  words: UserWordMap;
}

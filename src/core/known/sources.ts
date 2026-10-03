import { MY_WORDS_BOOK_ID, type BookId, type BookRole, type Settings } from '../settings/schema';
import type { BookMeta, SourceBookState } from '../wordbook/types';

/**
 * 熟词本多来源（追加需求 v3 第 6 条；词书扩充后任意词书都可作熟词本）：
 * - 本地熟词本（storage `knownWords`）始终生效；
 * - settings.knownBooks.enabled 可放任意词书 id，裁决规则见 isEffectiveKnownBook：
 *   - 来源熟词本 = 生效角色为 known 的来源词书（如欧路“已掌握”，或用户把某个远端分组指定为熟词本）；
 *   - 本地导入词书（“我的生词本”除外）；
 *   - 内置词书：ladder 书（cefr/coca 分级）作熟词本取“低于本档”的补集，其它书取书本身；
 * - 所有生效熟词本取并集，熟词优先于生词（WordMatcher 中命中熟词即不高亮）。
 * 生词本与熟词本互斥（非 ladder 书）由选项页 setter 保证；旧版本设备或手改设置可能同一 id 同时在两张表，读取时按生词本处理
 * （来源书也一样：角色为 known 的来源书若同时在 books.enabled 中，按生词本加载、熟词不生效，避免“启用了却什么都不标”）。
 */

/** 来源词书的生效角色：用户覆盖（settings.knownBooks.roles）> provider 声明 > 默认 new */
export function effectiveBookRole(state: Pick<SourceBookState, 'id' | 'role'>, settings: Pick<Settings, 'knownBooks'>): BookRole {
  return settings.knownBooks.roles[state.id] ?? state.role ?? 'new';
}

/**
 * 一本词书当前是否作为生效的熟词本（不要求已加载数据）：
 * - 来源词书：在 knownBooks.enabled 中、生效角色为 known（角色被改回 new 的书即使仍在 enabled 中也忽略），且不在 books.enabled 中
 *   （setSourceBookRole 改角色时会同步两张表；旧版 popup 等能把熟词角色的来源书加进生词本，此时按生词本处理）；
 * - 本地词书：在 knownBooks.enabled 中，不是“我的生词本”（卡片加词的默认写入目标，会被自动放回生词本），且不在 books.enabled 中；
 * - 内置词书：在 knownBooks.enabled 中；非 ladder 书若同时在 books.enabled 中按生词本处理（避免“启用了却什么都不标”），
 *   ladder 书两张表可同时含同一档（“本档及以上”与“低于本档”不相交）；
 *   group 书（计算机三档）与普通书一样只看本书：两张表可以各选一档（如生词本 cs-all + 熟词本 cs-250），同一档不能同时。
 */
export function isEffectiveKnownBook(settings: Pick<Settings, 'knownBooks' | 'books'>, meta: Pick<BookMeta, 'id' | 'kind' | 'ladder' | 'sync'>): boolean {
  if (!settings.knownBooks.enabled.includes(meta.id)) return false;
  // 非 ladder 书（来源、本地、内置）同时在生词本中：books.enabled 优先，按生词本处理
  if (settings.books.enabled.includes(meta.id) && !meta.ladder) return false;
  if (meta.kind === 'source') return !!meta.sync && effectiveBookRole(meta.sync, settings) === 'known';
  if (meta.kind === 'local') return meta.id !== MY_WORDS_BOOK_ID;
  return true;
}

/**
 * 启用中的有效熟词本 id（按 knownBooks.enabled 顺序，去重）。metas 为 registry.list() 的结果：
 * 不在其中的 id（来源索引里已没有的书、已删除的本地书、catalog 中不存在的内置书）一律忽略。
 */
export function enabledKnownBookIds(settings: Pick<Settings, 'knownBooks' | 'books'>, metas: readonly BookMeta[]): BookId[] {
  const byId = new Map(metas.map((m) => [m.id, m]));
  return [...new Set(settings.knownBooks.enabled)].filter((id) => {
    const meta = byId.get(id);
    return !!meta && isEffectiveKnownBook(settings, meta);
  });
}

/**
 * 词书是否“仅作熟词本”（popup、悬浮球的生词开关列表据此过滤）：
 * 来源词书看生效角色（角色为 known 的书即使暂未启用也不进生词列表；但已在 books.enabled 中时按生词本处理、保留在列表里，
 * 让用户能在生词开关里关掉它）；本地、内置的非 ladder 书看是否为生效熟词本。
 * ladder 书同一档可以同时作生词本，不过滤。group 书（计算机三档）只过滤真正作熟词本的那一档
 * （同组其它档仍可作生词本，如熟词本 cs-250 时 popup 仍可启用 cs-all）。
 */
export function isKnownOnlyBook(settings: Pick<Settings, 'knownBooks' | 'books'>, meta: Pick<BookMeta, 'id' | 'kind' | 'ladder' | 'sync'>): boolean {
  if (meta.kind === 'source') return !!meta.sync && effectiveBookRole(meta.sync, settings) === 'known' && !settings.books.enabled.includes(meta.id);
  if (meta.kind === 'builtin' && meta.ladder) return false;
  return isEffectiveKnownBook(settings, meta);
}

/**
 * 本地词书当前是否作为熟词本：这类书不能当“加入生词本”的目标，否则词写进熟词本反而不再高亮，与加入生词本的意图相反。
 * “我的生词本”永远不算（见 isEffectiveKnownBook）。
 */
export function isKnownLocalBook(settings: Pick<Settings, 'knownBooks' | 'books'>, id: BookId): boolean {
  return id.startsWith('local:') && isEffectiveKnownBook(settings, { id, kind: 'local' });
}

/**
 * 生效的默认“加入生词本”目标（卡片默认勾选与 background 写入共用）：排除已作熟词本的本地书
 * （选项页 setBookUsage 会同步清理 addTargets，这里兜底同步过来的旧设置），为空时退回“我的生词本”。
 */
export function effectiveAddTargets(settings: Pick<Settings, 'wordActions' | 'knownBooks' | 'books'>): BookId[] {
  const ids = [...new Set(settings.wordActions.addTargets)].filter((id) => !isKnownLocalBook(settings, id));
  return ids.length ? ids : [MY_WORDS_BOOK_ID];
}

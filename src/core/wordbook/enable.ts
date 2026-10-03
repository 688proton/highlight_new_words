import type { BookId } from '../settings/schema';
import type { BookMeta, CatalogBookMeta } from './types';

/** 判断组内单选所需的词书字段 */
export type SingleChoiceMeta = Pick<CatalogBookMeta, 'id'> & Partial<Pick<CatalogBookMeta, 'ladder' | 'group'>>;

/**
 * 单选组键：ladder（包含体系，如 cefr 选 B2 = B2+C1+C2、coca“3000 之外”已包含 5000 之外）或 group（嵌套的“前 N”集合，如计算机三档），
 * 同组同时启用多档没有意义。键加前缀区分两种来源，避免 ladder 与 group 同名时误判为同组。
 */
export function singleChoiceKey(meta: Partial<Pick<CatalogBookMeta, 'ladder' | 'group'>> | undefined): string | undefined {
  if (meta?.ladder) return `ladder:${meta.ladder}`;
  if (meta?.group) return `group:${meta.group}`;
  return undefined;
}

/**
 * 启用/停用一本词书后的列表（生词本 books.enabled 与熟词本 knownBooks.enabled 共用；
 * 选项页、首次引导、popup、悬浮球快捷设置都走这里）：
 * 启用时追加到末尾（优先级最低），停用时移除；启用的是单选组（同 ladder 或同 group）中的一档时，同时停用同组的其他档。
 * @param books 词书元数据，用来判断单选组；查不到的词书按普通词书处理
 */
export function toggleEnabledBooks(enabled: readonly BookId[], id: BookId, on: boolean, books: readonly SingleChoiceMeta[]): BookId[] {
  const rest = enabled.filter((b) => b !== id);
  if (!on) return rest;
  const key = singleChoiceKey(books.find((b) => b.id === id));
  if (!key) return [...rest, id];
  const sameGroup = new Set(books.filter((b) => singleChoiceKey(b) === key).map((b) => b.id));
  return [...rest.filter((b) => !sameGroup.has(b)), id];
}

/**
 * 一本书放进生词本 / 熟词本中的一张表时，另一张表里要移除的书（生词本与熟词本互斥）：
 * - ladder 书（cefr/coca 分级）：空，两张表互不影响（作生词本“本档及以上”与作熟词本“低于本档”不相交）；
 * - 其它书（含 group 书计算机三档、本地书）：只有自身。group 书两张表各自组内单选、可以各选一档
 *   （如生词本 cs-all + 熟词本 cs-250 = 全部减去前 250），只是同一档不能同时在两张表；
 * 来源书的熟词本由角色决定（setSourceBookRole），调用方不要用本函数处理来源书。
 */
export function crossTableExclusiveIds(meta: Pick<BookMeta, 'id' | 'kind'> & Partial<Pick<BookMeta, 'ladder'>>): Set<BookId> {
  return new Set(meta.kind === 'builtin' && meta.ladder ? [] : [meta.id]);
}

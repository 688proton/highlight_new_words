import type { BookMeta } from './types';

/**
 * 词书搜索（选项页词书页、popup 词书抽屉共用）：纯函数，无依赖。
 */

/** 搜索归一化：小写，去掉空格、连字符、下划线、间隔号、加号（“CET-6”“cet 6”“cet6”等价） */
export function normalizeBookQuery(s: string): string {
  return s.toLowerCase().replace(/[\s\-_·+]/g, '');
}

/**
 * 词书是否匹配搜索词：名称、英文名、简称、id、说明、来源（来源书为 provider 名，本地书含导入文件名）、许可、keywords、knownName，
 * 来源书再加远端分组名。空搜索词匹配全部。
 */
export function bookMatchesQuery(b: BookMeta, query: string): boolean {
  const q = normalizeBookQuery(query);
  if (!q) return true;
  const fields = [b.name, b.nameEn, b.short, b.id, b.description, b.source, b.license, b.knownName, b.sync?.name, ...(b.keywords ?? [])];
  return fields.some((f) => !!f && normalizeBookQuery(f).includes(q));
}

/** 是否命中“身份”字段（名称、简称、id、来源、许可、keywords、knownName、远端分组名），不含说明 */
function matchesIdentityFields(b: BookMeta, q: string): boolean {
  const fields = [b.name, b.nameEn, b.short, b.id, b.source, b.license, b.knownName, b.sync?.name, ...(b.keywords ?? [])];
  return fields.some((f) => !!f && normalizeBookQuery(f).includes(q));
}

/**
 * 按搜索词过滤词书列表（词书页、popup 抽屉用）：先看名称等身份字段，有命中就只返回这些；
 * 一本都没有时才退到说明里找。说明文字常顺带提到别的书（如分级书说明里的“已掌握 A1…”、C1 说明里的“六级”），
 * 全部列出会让结果很嘈杂；但只在说明里出现的词（如“牛津”“NGSL”的全称）仍能搜到。
 */
export function filterBooksByQuery<T extends BookMeta>(books: T[], query: string): T[] {
  const q = normalizeBookQuery(query);
  if (!q) return books;
  const strong = books.filter((b) => matchesIdentityFields(b, q));
  return strong.length ? strong : books.filter((b) => bookMatchesQuery(b, query));
}

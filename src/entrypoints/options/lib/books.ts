import { effectiveBookRole, isEffectiveKnownBook } from '@/core/known/sources';
import { MY_WORDS_BOOK_ID, type Settings } from '@/core/settings/schema';
import { getProviderInfo } from '@/core/source/providers';
import { crossTableExclusiveIds, singleChoiceKey, toggleEnabledBooks } from '@/core/wordbook/enable';
import { bookKindOf } from '@/core/wordbook/ids';
import { packagedBuiltinMetas } from '@/core/wordbook/packaged-catalog';
import type { BookCategory, BookMeta } from '@/core/wordbook/types';
import { dropNewBookTargets, setSourceBookRole } from './word-actions';

/** 词书分组标题与顺序（分组按 BookMeta.category；data 分片新增分类时在此补充标题即可，未知分类归入“其他”） */
export const CATEGORY_GROUPS: { category: BookCategory; title: string; hint: string }[] = [
  { category: 'level', title: '难度分级', hint: '按词汇难度分级（如 CEFR），选择适合自己的一档' },
  { category: 'exam', title: '考试词书', hint: '从中考到 GRE，可多选组合' },
  { category: 'frequency', title: '词频分级', hint: '按英语语料出现频率分段，越靠后越少见' },
  { category: 'core', title: '通用核心词', hint: '最常用的通用词表（NGSL 等），适合整体作熟词本，剔除基础词' },
  { category: 'domain', title: '专业领域', hint: '学术科研、商务、职场、医学、计算机等领域词表，是通用核心词之外的补充' },
  { category: 'other', title: '其他', hint: '' },
];

/** 词书类别徽标文案 */
export function bookKindLabel(b: BookMeta): string {
  if (b.kind === 'source') return getProviderInfo(b.providerId ?? '')?.name ?? '云端生词本';
  if (b.kind === 'local') return b.id === MY_WORDS_BOOK_ID ? '本地' : '导入';
  return b.short;
}

/**
 * 只显示书名的地方用的带归属名称：本地“我的生词本”与欧路默认分组“我的生词本”同名，必须带上归属才能区分。
 * 来源词书的 name 已是“欧路词典 · 分组名”；本地词书补“本地 · ”。
 */
export function bookDisplayName(b: Pick<BookMeta, 'kind' | 'name'>): string {
  return b.kind === 'local' ? `本地 · ${b.name}` : b.name;
}

/**
 * 熟词本列表（词书页“正在使用→熟词本”、熟词页）里一本书的说明行，两处共用保证文案一致。
 * 分级书（有 knownName）作熟词本是“低于该档”的补集：标题显示 knownName，说明行注明由哪一档设置；
 * 其它书整本作熟词，说明行显示类别与词数。
 */
export function knownBookNote(b: BookMeta): string {
  return b.knownName ? `由“${b.name}”设置 · 这些词不再高亮` : `${bookKindLabel(b)} · ${formatCount(b.size)} 词`;
}

/** 来源词书当前是否作为熟词本使用（provider 声明或用户指定）：熟词本不进高亮词书列表，在“熟词”页管理 */
export function isKnownRoleBook(settings: Settings, b: BookMeta): boolean {
  return b.kind === 'source' && !!b.sync && effectiveBookRole(b.sync, settings) === 'known';
}

export function isBookEnabled(settings: Settings, id: string): boolean {
  return settings.books.enabled.includes(id);
}

/**
 * 启用/停用词书（作生词本）：启用时追加到末尾（优先级最低），停用时移除。
 * 同 ladder / group 的书按组内单选处理（见 core/wordbook/enable.ts），能查到元数据时按 setBookUsage 保持生词本与熟词本互斥
 * （非 ladder 书启用为生词本时把自身移出熟词本）。
 * 内置书的元数据：传入的 books 中查不到这本书时（“全选”逐本调用、首次引导等调用方不传 books）用打包目录的元数据
 * （core/wordbook/packaged-catalog.ts），保证计算机三档这类 group 书不传元数据也组内单选。
 * 仍查不到元数据时（目录中没有的 id、用户词书）按 id 的类别处理互斥：
 * - 本地书：启用时移出熟词本；停用时也一并移出（本地书删除流程只调用本函数停用，借此不在设置里留下失效 id）；
 * - 内置书（目录中没有的 id）：启用时移出熟词本，不知道是不是 ladder 书，保守按互斥处理；
 * - 来源书：熟词本由角色决定（setSourceBookRole），这里不动。
 */
export function toggleBook(settings: Settings, id: string, on = !isBookEnabled(settings, id), books: readonly BookMeta[] = []) {
  const metas = bookKindOf(id) === 'builtin' && !books.some((b) => b.id === id) ? packagedBuiltinMetas() : books;
  const meta = metas.find((b) => b.id === id);
  if (on && meta) {
    setBookUsage(settings, meta, 'new', metas);
    return;
  }
  settings.books.enabled = toggleEnabledBooks(settings.books.enabled, id, on, metas);
  const kind = bookKindOf(id);
  if (kind === 'local' || (on && kind === 'builtin')) settings.knownBooks.enabled = settings.knownBooks.enabled.filter((b) => b !== id);
}

// ---------------- 词书三态：生词本 / 熟词本 / 不用 ----------------

/** 词书用法：生词本（books.enabled）/ 熟词本（knownBooks.enabled）/ 不用 */
export type BookUsage = 'new' | 'known' | 'off';

/** “我的生词本”不能作熟词本的原因（熟词按钮置灰的 title） */
export const MY_WORDS_KNOWN_DISABLED_REASON = '卡片加词写入这里，不能作熟词本';

/** 能否作熟词本：“我的生词本”是卡片加词的默认写入目标，background 会把它放回生词本，不能作熟词本 */
export function canUseAsKnown(b: Pick<BookMeta, 'id'>): boolean {
  return b.id !== MY_WORDS_BOOK_ID;
}

/**
 * 词书当前用法（生词、熟词两个开关的亮灭）。ladder 书（难度/词频分级）同一档可以两个都亮：
 * 作生词本是“本档及以上”，作熟词本是“低于本档”。熟词按裁决后的生效状态（core/known/sources.ts#isEffectiveKnownBook）。
 */
export function bookUsageOf(settings: Settings, b: BookMeta): { new: boolean; known: boolean } {
  return { new: isBookEnabled(settings, b.id), known: isEffectiveKnownBook(settings, b) };
}

/**
 * 设置词书用法（词书页“生词”“熟词”按钮）：
 * - 来源书：new/known 委托 setSourceBookRole（与来源页“用作”同一份状态）；off 时两表都移除，角色不变；
 * - 内置、本地书：在两张表间搬 id，各自按组内单选（toggleEnabledBooks）；非 ladder 书（含 group 书）同一本两表互斥，ladder 书只动目标表；
 *   已在目标表中的不改变顺序（生词本的优先级）；
 * - 本地书设为熟词本时从“加入生词本时写入”“标记熟词时移除”目标中移除；“我的生词本”不能设为熟词本（忽略）。
 * @returns removedTargets 被移除的单词操作目标名称，界面在提示中说明
 */
export function setBookUsage(settings: Settings, b: BookMeta, usage: BookUsage, books: readonly BookMeta[]): { removedTargets: string[] } {
  const without = (list: string[]) => list.filter((id) => id !== b.id);
  if (b.kind === 'source' && b.sync) {
    if (usage !== 'off') return setSourceBookRole(settings, b.sync, usage);
    settings.books.enabled = without(settings.books.enabled);
    settings.knownBooks.enabled = without(settings.knownBooks.enabled);
    return { removedTargets: [] };
  }
  if (usage === 'off') {
    settings.books.enabled = without(settings.books.enabled);
    settings.knownBooks.enabled = without(settings.knownBooks.enabled);
    return { removedTargets: [] };
  }
  if (usage === 'known' && !canUseAsKnown(b)) return { removedTargets: [] };
  // 另一张表中要移除的书：ladder 书两张表互不影响（“本档及以上”与“低于本档”不相交），为空；
  // 其它书（含计算机三档这类 group 书）只移除自身，group 书两张表可以各选一档（见 core/wordbook/enable.ts#crossTableExclusiveIds）
  const exclusiveIds = crossTableExclusiveIds(b);
  const dropExclusive = (list: string[]) => list.filter((id) => !exclusiveIds.has(id));
  if (usage === 'new') {
    if (!settings.books.enabled.includes(b.id)) settings.books.enabled = toggleEnabledBooks(settings.books.enabled, b.id, true, books);
    settings.knownBooks.enabled = dropExclusive(settings.knownBooks.enabled);
    return { removedTargets: [] };
  }
  if (!settings.knownBooks.enabled.includes(b.id)) settings.knownBooks.enabled = toggleEnabledBooks(settings.knownBooks.enabled, b.id, true, books);
  settings.books.enabled = dropExclusive(settings.books.enabled);
  return { removedTargets: b.kind === 'local' ? dropNewBookTargets(settings, b.id) : [] };
}

/**
 * 点击“生词”或“熟词”按钮：亮着的关掉（只关这一项，ladder 书另一张表不受影响；来源书关熟词时角色不变），
 * 不亮的按 setBookUsage 打开（非 ladder 书会关掉另一项）。
 */
export function toggleBookUsage(settings: Settings, b: BookMeta, usage: Exclude<BookUsage, 'off'>, books: readonly BookMeta[]): { removedTargets: string[] } {
  if (!bookUsageOf(settings, b)[usage]) return setBookUsage(settings, b, usage, books);
  if (usage === 'new') settings.books.enabled = settings.books.enabled.filter((id) => id !== b.id);
  else settings.knownBooks.enabled = settings.knownBooks.enabled.filter((id) => id !== b.id);
  return { removedTargets: [] };
}

/** 词书页筛选：全部 / 生词本 / 熟词本 / 未使用 */
export type BookUsageFilter = 'all' | 'new' | 'known' | 'unused';

export function matchesUsageFilter(settings: Settings, b: BookMeta, filter: BookUsageFilter): boolean {
  if (filter === 'all') return true;
  const usage = bookUsageOf(settings, b);
  if (filter === 'unused') return !usage.new && !usage.known;
  return usage[filter];
}

// 搜索匹配移到 core/wordbook/search.ts（popup 词书抽屉也用，避免 popup 引入选项页的依赖），这里转出保持原有引用
export { bookMatchesQuery, filterBooksByQuery, normalizeBookQuery } from '@/core/wordbook/search';

/** 组内是否有包含体系（ladder）书：这类组不提供“全选”，生词/熟词各自单选 */
export function hasLadderBooks(list: readonly Pick<BookMeta, 'ladder'>[]): boolean {
  return list.some((b) => !!b.ladder);
}

/** 调整启用顺序（优先级），delta=-1 上移 */
export function moveBook(settings: Settings, id: string, delta: number) {
  const list = [...settings.books.enabled];
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  settings.books.enabled = list;
}

/** 数字千分位（词数展示） */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前 / 日期 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return '从未';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** 中文界面的日期时间：2026/10/1 16:15（不随浏览器语言变成 en-US 的 10/1/2026, 4:15 PM） */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * 分类内的显示顺序：全量书按难度排序，增量书（delta，如“六级新增”）紧跟在它的全量书之后，
 * 避免“专四”这类同级书插在“考研”与“考研新增”之间。
 */
export function orderCategoryBooks<T extends Pick<BookMeta, 'id' | 'level' | 'delta'>>(list: T[]): T[] {
  const full = list.filter((b) => !b.delta).sort((a, b) => a.level - b.level);
  const deltas = list.filter((b) => b.delta);
  const out: T[] = [];
  for (const b of full) out.push(b, ...deltas.filter((d) => d.delta!.of === b.id));
  // 找不到全量书的增量书放最后（数据不完整时不丢书）
  for (const d of deltas) if (!out.includes(d)) out.push(d);
  return out;
}

/**
 * “全选”要勾选的书：只选全量书，不选增量书——增量书完全包含在对应全量书中，一起选只会重复计数。
 * 单选组（同 ladder 或同 group，见 core/wordbook/enable.ts#singleChoiceKey）只取词数最多的一档（如计算机取“全部”，
 * 嵌套集合中它包含其它档），保证全选后仍是组内单选、全选框能勾上。
 * 难度分级、词频分级整组是包含体系，界面不提供全选（见 hasLadderBooks）。
 */
export function selectAllIds(list: readonly Pick<BookMeta, 'id' | 'delta' | 'ladder' | 'group' | 'size'>[]): string[] {
  const full = list.filter((b) => !b.delta);
  /** 单选组键 -> 该组词数最多的一档 */
  const pick = new Map<string, Pick<BookMeta, 'id' | 'size'>>();
  for (const b of full) {
    const key = singleChoiceKey(b);
    const cur = key ? pick.get(key) : undefined;
    if (key && (!cur || b.size > cur.size)) pick.set(key, b);
  }
  return full.filter((b) => {
    const key = singleChoiceKey(b);
    return !key || pick.get(key)?.id === b.id;
  }).map((b) => b.id);
}

/**
 * 组标题“全选 / 全不选”（供词书页使用，代替逐本调用 toggleBook 时漏传元数据）：
 * - 全选：按 selectAllIds 逐本启用为生词本（带元数据：组内单选），跳过当前作熟词本的书（isUsedAsKnown），
 *   不悄悄把用户设的熟词本改成生词本；单选组被选中的那一档作熟词本时该组整组跳过，不改选别的档；
 * - 全不选：只把组内的书移出生词本（books.enabled），熟词本用法不动——不经 toggleBook，它停用本地书时会一并移出熟词本。
 * @param books 全部词书元数据（判断单选组），缺省为 list
 * @returns skippedKnown 全选时因作熟词本而跳过的书，界面在提示中说明
 */
export function toggleAllBooks(settings: Settings, list: readonly BookMeta[], on: boolean, books: readonly BookMeta[] = list): { skippedKnown: BookMeta[] } {
  if (!on) {
    const ids = new Set(list.map((b) => b.id));
    settings.books.enabled = settings.books.enabled.filter((id) => !ids.has(id));
    return { skippedKnown: [] };
  }
  const byId = new Map(list.map((b) => [b.id, b]));
  const skippedKnown: BookMeta[] = [];
  for (const id of selectAllIds(list)) {
    const b = byId.get(id)!;
    if (isUsedAsKnown(settings, b)) skippedKnown.push(b);
    else toggleBook(settings, id, true, books);
  }
  return { skippedKnown };
}

/**
 * 词书当前是否作熟词本（全选要跳过的书）：熟词按钮亮着（生效熟词本），或来源书的生效角色为熟词本
 * （熟词角色的来源书即使不在 knownBooks.enabled 中，启用为生词本也会改它的角色）。
 */
export function isUsedAsKnown(settings: Settings, b: BookMeta): boolean {
  return bookUsageOf(settings, b).known || isKnownRoleBook(settings, b);
}

/** “全选”框的勾选状态：全选会启用的书（selectAllIds 中不作熟词本的）都已是生词本时为勾选；没有可启用的书时不勾 */
export function allBooksSelected(settings: Settings, list: readonly BookMeta[]): boolean {
  const byId = new Map(list.map((b) => [b.id, b]));
  const ids = selectAllIds(list).filter((id) => !isUsedAsKnown(settings, byId.get(id)!));
  return ids.length > 0 && ids.every((id) => isBookEnabled(settings, id));
}

/** 增量书的全量书已启用：增量书已被包含，列表中置灰说明 */
export function deltaCoveredBy(settings: Settings, b: Pick<BookMeta, 'delta'>, byId: Map<string, Pick<BookMeta, 'short'>>): string | undefined {
  if (!b.delta || !isBookEnabled(settings, b.delta.of)) return undefined;
  return byId.get(b.delta.of)?.short ?? b.delta.of;
}

/** 徽标文字：一般最多 3 个字符（“六级”“有道”）；带“+”的增量简称保留加号（“GRE+”“雅思+”），不与全量书重复 */
export function bookBadge(label: string): string {
  const s = label.replace(/词典$/, '');
  return s.endsWith('+') ? s.slice(0, 4) : s.slice(0, 3);
}

/**
 * 已启用词书的去重词数（并集）：逐本加载词表求并集（内置词书合计不到 1MB，用户词书来自本地缓存）。
 * 加载失败的书按其 size 估算（结果标为估算）。
 */
export async function unionWordCount(ids: string[], load: (id: string) => Promise<{ words(): Iterable<string> } | undefined>, sizeOf: (id: string) => number): Promise<{ count: number; exact: boolean }> {
  const all = new Set<string>();
  let extra = 0;
  let exact = true;
  const loaded = await Promise.all(ids.map((id) => load(id).catch(() => undefined)));
  loaded.forEach((book, i) => {
    if (!book) {
      extra += sizeOf(ids[i]!);
      exact = false;
      return;
    }
    for (const w of book.words()) all.add(w);
  });
  return { count: all.size + extra, exact };
}

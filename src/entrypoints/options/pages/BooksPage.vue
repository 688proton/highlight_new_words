<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { effectiveBookRole, enabledKnownBookIds } from '@/core/known/sources';
import { resolveMarkStyle } from '@/core/theme/resolve';
import { singleChoiceKey } from '@/core/wordbook/enable';
import { createExtensionLoaders, DefaultWordBookRegistry } from '@/core/wordbook/registry';
import type { BookMeta } from '@/core/wordbook/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import {
  CATEGORY_GROUPS,
  allBooksSelected,
  MY_WORDS_KNOWN_DISABLED_REASON,
  bookDisplayName,
  bookKindLabel,
  bookUsageOf,
  canUseAsKnown,
  deltaCoveredBy,
  filterBooksByQuery,
  formatCount,
  hasLadderBooks,
  isBookEnabled,
  knownBookNote,
  matchesUsageFilter,
  moveBook,
  normalizeBookQuery,
  orderCategoryBooks,
  toggleAllBooks,
  toggleBook,
  toggleBookUsage,
  unionWordCount,
  type BookUsageFilter,
} from '../lib/books';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';
import BookRow from '../components/BookRow.vue';

/**
 * 词书页：顶部吸顶搜索 + 用法筛选 → 正在使用（生词本按优先级排序、熟词本可移出）→ 我的词书 → 各分类内置词书。
 * 每本书三态（生词本 / 熟词本 / 不用），见 BookRow 与 lib/books.ts#setBookUsage。
 * 生词本的启用顺序决定一个词同时命中多本书时用哪本的颜色。
 */
const { settings, books, navigate } = useOptions();

const byId = computed(() => new Map(books.value.map((b) => [b.id, b])));
const enabled = computed(() =>
  settings.value.books.enabled.map((id) => ({ id, meta: byId.value.get(id) })),
);

// ---------------- 搜索与筛选 ----------------

const query = ref('');
const filter = ref<BookUsageFilter>('all');
const FILTERS: { value: BookUsageFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '生词本' },
  { value: 'known', label: '熟词本' },
  { value: 'unused', label: '未使用' },
];
/** 正在搜索或筛选：命中的组强制展开、没有命中的组隐藏，“正在使用”收起让结果靠前 */
const searching = computed(() => !!normalizeBookQuery(query.value) || filter.value !== 'all');
/** 搜索命中的书（名称等身份字段优先，全无命中才查说明，见 filterBooksByQuery） */
const queryHits = computed(() => new Set(filterBooksByQuery(books.value, query.value).map((b) => b.id)));
const visible = (b: BookMeta) => queryHits.value.has(b.id) && matchesUsageFilter(settings.value, b, filter.value);
function clearSearch() {
  query.value = '';
  filter.value = 'all';
}

// ---------------- 分组与折叠 ----------------

// “我的词书”：来源与本地词书，来源熟词本（欧路“已掌握”等）也在这里用三态统一管理
const userBooks = computed(() => books.value.filter((b) => b.kind !== 'builtin'));
const shownUserBooks = computed(() => userBooks.value.filter(visible));
const groups = computed(() => {
  const known = new Set(CATEGORY_GROUPS.map((g) => g.category));
  return CATEGORY_GROUPS.map((g) => {
    // 增量书紧跟其全量书（见 orderCategoryBooks）
    const all = orderCategoryBooks(books.value.filter((b) => b.kind === 'builtin' && (b.category === g.category || (g.category === 'other' && !known.has(b.category)))));
    return { ...g, all, ladder: hasLadderBooks(all), books: all.filter(visible) };
  }).filter((g) => g.books.length > 0);
});
const noResults = computed(() => searching.value && !shownUserBooks.value.length && !groups.value.length);

/** 用户收起的组（localStorage 记忆，per-viewer 便利项；隐私模式等读写失败时按全部展开处理） */
const COLLAPSE_KEY = 'hnw.books.collapsed';
function readCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const collapsed = ref(new Set<string>(readCollapsed()));
function toggleCollapse(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
  } catch {
    // 存不了就只在本次打开期间生效
  }
}
const isOpen = (key: string) => searching.value || !collapsed.value.has(key);

// ---------------- 正在使用 ----------------

/** 生效的熟词本（内置、本地、来源），ladder 书显示补集名称（如“A1–B1（B2 以下）”） */
const knownInUse = computed(() =>
  enabledKnownBookIds(settings.value, books.value)
    .map((id) => byId.value.get(id))
    .filter((b): b is BookMeta => !!b),
);

/**
 * 已启用词书的去重词数：各本词表求并集（增量书与全量书、各考试书之间大量重叠，直接相加会严重高估）。
 * 结果异步算出；算出前先显示按本相加的上限。
 */
const union = ref<{ key: string; count: number; exact: boolean }>();
const enabledKey = computed(() => enabled.value.map((e) => `${e.id}:${e.meta?.size ?? 0}`).join(','));
watch(
  enabledKey,
  async (key) => {
    const ids = enabled.value.map((e) => e.id);
    // 每次新建注册表：用户词书同步后内容会变，注册表内部按 id 缓存（内置词书文件有浏览器缓存，重复加载开销小）
    const registry = new DefaultWordBookRegistry(createExtensionLoaders());
    const r = await unionWordCount(ids, (id) => registry.load(id), (id) => byId.value.get(id)?.size ?? 0);
    if (key === enabledKey.value) union.value = { key, ...r };
  },
  { immediate: true },
);
const totalText = computed(() => {
  const u = union.value;
  if (u && u.key === enabledKey.value) return `约 ${formatCount(u.count)} 词（去重后）`;
  return '正在计算词数…';
});

// ---------------- 切换 ----------------

/**
 * 全选只选全量书（增量书完全包含在全量书中，单选组只取一档），跳过作熟词本的书并提示；
 * 全不选只停用组内的生词本用法，熟词本不动（见 lib/books.ts#toggleAllBooks）
 */
function groupAll(list: BookMeta[], on: boolean) {
  const { skippedKnown } = toggleAllBooks(settings.value, list, on, books.value);
  if (skippedKnown.length) showToast(`“${skippedKnown.map(bookDisplayName).join('”“')}”正作熟词本，全选已跳过；要改作生词本请点它的“生词”`);
}
const allSelected = (list: BookMeta[]) => allBooksSelected(settings.value, list);

/**
 * 点“生词”或“熟词”（整行点击 = 生词）：亮着的关掉，不亮的打开（非 ladder 书会关掉另一项，见 lib/books.ts#toggleBookUsage）。
 * 来源书切换会改“用作”角色、本地书设为熟词本会移出单词操作目标，用提示说明。
 */
function toggleUsage(b: BookMeta, usage: 'new' | 'known') {
  const roleBefore = b.sync ? effectiveBookRole(b.sync, settings.value) : undefined;
  const { removedTargets } = toggleBookUsage(settings.value, b, usage, books.value);
  const roleAfter = b.sync ? effectiveBookRole(b.sync, settings.value) : undefined;
  const parts: string[] = [];
  if (roleBefore !== roleAfter) parts.push(roleAfter === 'known' ? `“${b.sync!.name}”改为熟词本：其中的词不再高亮` : `“${b.sync!.name}”改为生词本：已从熟词中移出并启用高亮`);
  else if (removedTargets.length) parts.push(`“${bookDisplayName(b)}”已作熟词本`);
  // 被移除的单词操作目标不会在改回用途时自动恢复，提示里说清楚
  if (removedTargets.length) parts.push(`已从单词操作的“${removedTargets.join('”“')}”目标中去掉，需要时请到“单词操作”重新勾选`);
  if (parts.length) showToast(parts.join('；'));
}
const usageOf = (b: BookMeta) => bookUsageOf(settings.value, b);
</script>

<template>
  <div class="toolbar" role="search">
    <label class="search">
      <AppIcon name="search" :size="18" />
      <input v-model="query" type="search" placeholder="搜索词书：名称 / 简称 / 考试 / 来源" aria-label="搜索词书" />
      <button v-if="query" type="button" class="clear" aria-label="清除搜索" @click="query = ''"><AppIcon name="close" :size="16" /></button>
    </label>
    <div class="filters" role="radiogroup" aria-label="按用法筛选">
      <button v-for="f in FILTERS" :key="f.value" type="button" role="radio" :aria-checked="filter === f.value" :class="{ on: filter === f.value }" @click="filter = f.value">
        {{ f.label }}
      </button>
    </div>
  </div>

  <SettingsSection v-if="!searching" id="enabled" class="anchor" title="正在使用" flush>
    <template #actions>
      <span class="muted total">生词 {{ enabled.length }} 本 · {{ totalText }}</span>
    </template>
    <h3 class="sub-title">生词本<span class="muted">（高亮，一个词同时出现在多本书中时，排在前面的决定颜色）</span></h3>
    <ol v-if="enabled.length" class="enabled">
      <li v-for="(e, i) in enabled" :key="e.id">
        <span class="rank">{{ i + 1 }}</span>
        <span class="sample"><MarkPreview :mark="resolveMarkStyle(settings, e.id)" word="Aa" /></span>
        <span class="name">
          <span class="title">{{ e.meta ? bookDisplayName(e.meta) : e.id }}</span>
          <span class="muted">
            <template v-if="e.meta">{{ bookKindLabel(e.meta) }} · {{ formatCount(e.meta.size) }} 词</template>
            <template v-else>词书不存在或尚未加载</template>
          </span>
        </span>
        <span class="ops">
          <button type="button" class="icon-btn" :disabled="i === 0" aria-label="上移" @click="moveBook(settings, e.id, -1)"><AppIcon name="up" :size="18" /></button>
          <button type="button" class="icon-btn" :disabled="i === enabled.length - 1" aria-label="下移" @click="moveBook(settings, e.id, 1)"><AppIcon name="down" :size="18" /></button>
          <button type="button" class="icon-btn" aria-label="停用" @click="toggleBook(settings, e.id, false, books)"><AppIcon name="close" :size="18" /></button>
        </span>
      </li>
    </ol>
    <p v-else class="empty">还没有启用生词本，从下面选择一本或几本开始吧。</p>

    <h3 class="sub-title">熟词本<span class="muted">（其中的词不高亮，优先于生词本）</span></h3>
    <ul class="enabled known">
      <li>
        <span class="k-ico"><AppIcon name="known" :size="18" /></span>
        <span class="name">
          <span class="title">本地熟词本</span>
          <span class="muted">卡片上点“认识”写入这里</span>
        </span>
        <span class="always">始终生效</span>
      </li>
      <li v-for="b in knownInUse" :key="b.id">
        <span class="k-ico">{{ bookKindLabel(b).slice(0, 2) }}</span>
        <span class="name">
          <span class="title">{{ b.knownName ?? bookDisplayName(b) }}</span>
          <span class="muted">{{ knownBookNote(b) }}</span>
        </span>
        <span class="ops">
          <button type="button" class="icon-btn" :aria-label="'移出熟词本 ' + b.name" @click="toggleUsage(b, 'known')"><AppIcon name="close" :size="18" /></button>
        </span>
      </li>
    </ul>
    <div class="foot">
      <button type="button" class="link" @click="navigate('appearance', 'per-book')">
        <AppIcon name="palette" :size="16" />为不同词书设置颜色
      </button>
      <button type="button" class="link" @click="navigate('known', 'known-sources')">
        <AppIcon name="known" :size="16" />熟词设置
      </button>
    </div>
  </SettingsSection>

  <SettingsSection v-if="!searching || shownUserBooks.length" id="mine" class="anchor" title="我的词书" description="有道 / 欧路同步的生词本、文件导入和卡片加词的本地词书，可作生词本或熟词本" flush>
    <template #actions>
      <button type="button" class="btn small" @click="navigate('sources')"><AppIcon name="plus" :size="16" />添加</button>
      <button type="button" class="fold" :aria-expanded="isOpen('mine')" :aria-label="isOpen('mine') ? '收起我的词书' : '展开我的词书'" :disabled="searching" @click="toggleCollapse('mine')">
        <AppIcon :name="isOpen('mine') ? 'up' : 'down'" :size="18" />
      </button>
    </template>
    <template v-if="isOpen('mine')">
      <ul v-if="shownUserBooks.length" class="list">
        <BookRow
          v-for="b in shownUserBooks"
          :key="b.id"
          :book="b"
          :on="usageOf(b).new"
          :known="usageOf(b).known"
          :known-disabled="canUseAsKnown(b) ? undefined : MY_WORDS_KNOWN_DISABLED_REASON"
          @toggle="toggleUsage(b, 'new')"
          @toggle-known="toggleUsage(b, 'known')"
        />
      </ul>
      <div v-else class="empty-cta">
        <p class="muted">同步有道 / 欧路的生词本，或导入 CSV、TXT、Anki 等文件，作为自己的词书高亮。</p>
        <div class="row">
          <button type="button" class="btn primary" @click="navigate('sources', 'providers')">同步云端生词本</button>
          <button type="button" class="btn" @click="navigate('sources', 'import')">导入文件</button>
        </div>
      </div>
    </template>
  </SettingsSection>

  <SettingsSection v-for="g in groups" :id="'cat-' + g.category" class="anchor" :key="g.category" :title="g.title" :description="g.hint" flush>
    <template #actions>
      <!-- 包含体系（难度分级、词频分级）不提供全选：各档生词/熟词各自单选；搜索/筛选时只显示部分书，全选整组会误操作，也不显示 -->
      <button v-if="!g.ladder && !searching && isOpen(g.category)" type="button" class="btn small" @click="groupAll(g.all, !allSelected(g.all))">
        {{ allSelected(g.all) ? '全不选' : '全选' }}
      </button>
      <button type="button" class="fold" :aria-expanded="isOpen(g.category)" :aria-label="(isOpen(g.category) ? '收起' : '展开') + g.title" :disabled="searching" @click="toggleCollapse(g.category)">
        <AppIcon :name="isOpen(g.category) ? 'up' : 'down'" :size="18" />
      </button>
    </template>
    <template v-if="isOpen(g.category)">
      <p v-if="g.ladder" class="hint-inc muted">各档是包含关系：生词选一档 = 该档及以上；熟词选一档 = 低于该档。两边各选一档，可以同时选。</p>
      <!-- 通用核心词组的说明（CATEGORY_GROUPS.hint）已写明用途；专业领域补充与 NGSL 的搭配、计算机三档的切分方式 -->
      <p v-else-if="g.category === 'domain'" class="hint-inc muted">
        学术、商务、职场词表是 NGSL 之外的补充，作熟词本时建议和 NGSL 一起选。计算机三档按论文语料词频切分（非官方分级），生词、熟词各选一档：如“全部”作生词 + “前 250”作熟词 = 只标前 250 之外的词。
      </p>
      <ul class="list">
        <BookRow
          v-for="b in g.books"
          :key="b.id"
          :book="b"
          :on="usageOf(b).new"
          :known="usageOf(b).known"
          :radio="!!singleChoiceKey(b)"
          :covered-by="deltaCoveredBy(settings, b, byId)"
          @toggle="toggleUsage(b, 'new')"
          @toggle-known="toggleUsage(b, 'known')"
        />
      </ul>
    </template>
  </SettingsSection>

  <div v-if="noResults" class="no-results">
    <p>没有匹配的词书</p>
    <button type="button" class="btn" @click="clearSearch">清除搜索与筛选</button>
  </div>
</template>

<style scoped>
/* 吸顶搜索栏：在页面头部之下固定，背景与页面一致，避免列表透出；窄屏选项页有 57px 吸顶顶栏，搜索栏贴在它下面 */
.toolbar { position: sticky; top: var(--books-sticky-top, 0px); z-index: 5; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
  padding: 8px 0; margin: -8px 0 0; background: var(--bg); }
.search { flex: 1 1 260px; min-width: 0; position: relative; display: flex; align-items: center; color: var(--text-2); }
.search :deep(svg) { position: absolute; left: 10px; pointer-events: none; }
.search input { padding-left: 36px; padding-right: 36px; min-height: 40px; border-radius: 10px; }
.search input::-webkit-search-cancel-button { display: none; }
.clear { position: absolute; right: 2px; width: 36px; height: 36px; border: 0; background: transparent; color: var(--text-2); cursor: pointer;
  display: grid; place-items: center; border-radius: 8px; }
.filters { display: flex; gap: 3px; padding: 3px; background: var(--surface-2); border-radius: 10px; flex: none; max-width: 100%; overflow-x: auto; }
.filters button { min-height: 34px; padding: 0 12px; border: 0; background: transparent; border-radius: 8px; cursor: pointer; font-size: 13px;
  color: var(--text-2); white-space: nowrap; }
.filters button.on { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
.total { white-space: nowrap; }
/* 锚点（如 #books/cat-exam）定位时避开吸顶搜索栏（SettingsSection 自带 72px 只够避开顶栏） */
section.anchor { scroll-margin-top: 80px; }
@media (max-width: 899px) {
  /* 搜索栏铺满内容区两侧留白，避免滚动时列表从边缘透出 */
  .toolbar { --books-sticky-top: 57px; margin: -8px -12px 0; padding: 8px 12px; }
  section.anchor { scroll-margin-top: 130px; }
}
.sub-title { margin: 4px 18px 6px; font-size: 13px; font-weight: 650; }
.sub-title .muted { font-weight: 400; font-size: 12px; }
.hint-inc { margin: -4px 18px 8px; font-size: 12px; }
.enabled { list-style: none; margin: 0 0 8px; padding: 0; }
.enabled li { display: flex; align-items: center; gap: 10px; padding: 8px 18px; min-height: 56px; border-top: 1px solid var(--border); }
.rank { width: 20px; text-align: center; color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.sample { width: 40px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: #fff; color: #1f2328;
  border: 1px solid var(--border); font: 600 15px/1 Georgia, serif; flex: none; }
.k-ico { width: 32px; height: 32px; margin-left: 30px; border-radius: 8px; display: grid; place-items: center; flex: none; font-size: 11px; font-weight: 700;
  background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
.always { font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 600; white-space: nowrap; color: var(--success);
  background: color-mix(in srgb, var(--success) 14%, transparent); }
.name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 2px; }
.icon-btn, .fold { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.icon-btn:hover:not(:disabled), .fold:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.icon-btn:disabled { opacity: .3; cursor: default; }
.fold:disabled { opacity: .35; cursor: default; }
/* 触屏点击区 ≥ 44px：图标按钮、折叠、筛选、搜索框与其清除按钮 */
@media (pointer: coarse) {
  .icon-btn, .fold, .clear { width: 44px; height: 44px; }
  .filters button { min-height: 44px; }
  .search input { min-height: 44px; padding-right: 46px; }
}
.empty { margin: 0 0 8px; padding: 16px 18px; color: var(--text-2); border-top: 1px solid var(--border); }
.foot { display: flex; flex-wrap: wrap; gap: 0 12px; padding: 6px 12px 4px; border-top: 1px solid var(--border); }
.link { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--accent); cursor: pointer;
  min-height: var(--tap); padding: 0 6px; font-weight: 600; }
.list { list-style: none; margin: 0; padding: 0; }
.empty-cta { padding: 4px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.empty-cta p { margin: 0; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
.no-results { text-align: center; padding: 32px 16px; color: var(--text-2); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.no-results p { margin: 0; }
@media (max-width: 480px) {
  .toolbar { gap: 8px; }
  section.anchor { scroll-margin-top: 172px; }
  .search { flex-basis: 100%; }
  .filters { width: 100%; }
  .filters button { flex: 1 0 auto; }
  .enabled li { padding: 8px 10px 8px 14px; gap: 8px; }
  .k-ico { margin-left: 0; }
  .sub-title { margin: 4px 14px 6px; }
  .hint-inc { margin: -4px 14px 8px; }
}
</style>

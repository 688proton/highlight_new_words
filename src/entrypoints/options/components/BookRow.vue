<script setup lang="ts">
import { computed } from 'vue';
import { MY_WORDS_BOOK_ID } from '@/core/settings/schema';
import type { BookMeta } from '@/core/wordbook/types';
import { bookBadge, bookDisplayName, bookKindLabel, formatCount, relativeTime } from '../lib/books';

/**
 * 词书行（三态）：左侧简称徽标，中间名称与说明，右侧“生词”“熟词”两个切换按钮（aria-pressed），两个都不亮 = 不用。
 * - 整行（徽标 + 文字区）点击仍切换“生词”，保持原有习惯；
 * - radio=true（同 ladder / group 组内单选，如难度分级、计算机三档）时生词、熟词按钮前带单选圆点；
 * - 熟词按钮亮起时说明行显示作熟词本时的名称（knownName，ladder 书是“低于本档”的补集，如“A1–B1（B2 以下）”）；
 * - knownDisabled 有值时熟词按钮置灰并以它作 title（“我的生词本”不能作熟词本）；
 * - 带许可的数据（CC BY-SA 等）在说明行展示“许可 · 来源”：许可放前面，窄屏来源较长被截断时许可仍可见（窄屏还允许折成两行）。
 * 不传 known（undefined）时不显示熟词按钮（如首次引导只做生词）。
 */
/** coveredBy：增量书的全量书已启用时传全量书简称（如“六级”），行内置灰并说明“已包含在六级中”（只影响“生词”） */
const props = defineProps<{ book: BookMeta; on: boolean; known?: boolean; radio?: boolean; coveredBy?: string; knownDisabled?: string }>();
const emit = defineEmits<{ toggle: []; 'toggle-known': [] }>();

const sub = computed(() => {
  const b = props.book;
  if (b.kind === 'source') {
    const s = b.sync;
    if (!s) return '';
    if (s.status === 'error') return '同步失败：' + (s.error ?? '');
    return s.lastSyncAt ? `同步于 ${relativeTime(s.lastSyncAt)}` : '尚未同步';
  }
  if (b.kind === 'local') return b.id === MY_WORDS_BOOK_ID ? `卡片加词时自动创建 · 更新于 ${relativeTime(b.updatedAt ?? 0)}` : `导入于 ${relativeTime(b.updatedAt ?? 0)}`;
  return b.description ?? b.nameEn;
});
/** 作熟词本时的说明：ladder 书显示补集名称，其它书说明整本作熟词 */
const knownNote = computed(() => (props.book.knownName ? `作熟词本：${props.book.knownName}` : '作熟词本：其中的词不再高亮'));
/** 许可说明：如“CC BY-SA 4.0 · NGSL Project”（许可在前，见组件说明） */
const licenseNote = computed(() => (props.book.license ? [props.book.license, props.book.source].filter(Boolean).join(' · ') : ''));
/** 增量词书说明：如“六级 − 四级/高考/中考” */
const deltaTitle = computed(() => (props.book.delta ? `${props.book.delta.of} − ${props.book.delta.minus.join(' / ')}` : ''));
// 徽标：如“六级”“GRE+”“本地”“有道”（规则见 bookBadge）
const badge = computed(() => bookBadge(bookKindLabel(props.book)));
const showKnown = computed(() => props.known !== undefined);
</script>

<template>
  <li class="row" :class="{ covered: !!coveredBy && !on, 'is-on': on, 'is-known': !!known }">
    <button type="button" class="book" :role="radio ? 'radio' : 'switch'" :aria-checked="on" :title="sub" @click="emit('toggle')">
      <span class="badge" :class="book.kind">{{ badge }}</span>
      <span class="text">
        <span class="name">{{ bookDisplayName(book) }}<span v-if="book.delta" class="tag" :title="deltaTitle">增量</span></span>
        <span v-if="coveredBy && !on" class="sub covered-note">已包含在{{ coveredBy }}中，无需再选</span>
        <span v-if="known" class="sub known-note">{{ knownNote }}</span>
        <span class="sub" :class="{ err: book.sync?.status === 'error' }"><span class="count-inline">{{ formatCount(book.size) }} 词 · </span>{{ sub }}</span>
        <span v-if="licenseNote" class="sub license" :title="licenseNote">{{ licenseNote }}</span>
      </span>
      <span class="count">{{ formatCount(book.size) }}<small>词</small></span>
      <span v-if="!showKnown" class="check" :class="{ on, radio }" aria-hidden="true" />
    </button>
    <span v-if="showKnown" class="usage" role="group" :aria-label="'用法：' + book.name">
      <button type="button" class="use new" :class="{ radio }" :aria-pressed="on" :aria-label="'作生词本 ' + book.name" @click="emit('toggle')">生词</button>
      <button
        type="button"
        class="use known"
        :class="{ radio }"
        :aria-pressed="!!known"
        :aria-label="'作熟词本 ' + book.name"
        :disabled="!!knownDisabled"
        :title="knownDisabled || (book.knownName ? '作熟词本：' + book.knownName : '作熟词本：其中的词不再高亮')"
        @click="emit('toggle-known')"
      >熟词</button>
    </span>
  </li>
</template>

<style scoped>
.row { display: flex; align-items: center; border-top: 1px solid var(--border); padding-right: 14px; }
.row:hover { background: var(--surface-2); }
.book { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 18px; min-height: 60px; border: 0;
  background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.book:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.badge { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex: none; font-size: 12px; font-weight: 700;
  background: var(--surface-2); color: var(--text-2); letter-spacing: -.02em; }
.badge.source { background: color-mix(in srgb, #0ea5e9 14%, transparent); color: #0284c7; }
.badge.local { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #7c3aed; }
.is-on .badge.builtin { background: var(--accent-soft); color: var(--accent); }
.is-known:not(.is-on) .badge.builtin { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub.err { color: var(--danger); }
.sub.license { opacity: .85; }
.known-note { color: var(--success); font-weight: 600; }
.count-inline { display: none; }
.covered .badge, .covered .name, .covered .count { opacity: .55; }
.covered-note { color: var(--accent); }
/* 触屏没有 title 提示：说明（含许可行）最多两行，“已去掉 xxx 个基础词”、许可与来源等关键信息能看全 */
@media (max-width: 560px), (pointer: coarse) {
  .sub:not(.covered-note):not(.known-note) { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4; }
}
.count { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 13px; white-space: nowrap; }
.count small { margin-left: 2px; font-size: 11px; }
/* 无熟词按钮时（只做生词开关）的勾选圈 */
.check { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--border); flex: none; transition: background .15s, border-color .15s; }
.check.on { background: var(--accent); border-color: var(--accent); }
.check.radio.on { background: var(--surface); border: 7px solid var(--accent); }
.tag { margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); vertical-align: 1px; }
/* 生词 / 熟词 切换按钮：亮起分别用主色、成功色 */
.usage { display: flex; gap: 6px; flex: none; }
.use { min-width: 52px; min-height: 36px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
  color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.use:hover:not(:disabled) { border-color: var(--text-2); color: var(--text); }
.use:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.use.new[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.use.known[aria-pressed='true'] { background: var(--success); border-color: var(--success); color: var(--surface); }
.use:disabled { opacity: .4; cursor: not-allowed; }
/* 单选组（难度/词频分级、计算机三档）两个按钮前带圆点，提示生词、熟词各选一档 */
.use.radio::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; border: 1.5px solid currentColor; vertical-align: 1px; }
.use.radio[aria-pressed='true']::before { background: currentColor; }
/* 触屏点击区 ≥ 44px */
@media (pointer: coarse) { .use { min-height: 44px; min-width: 52px; } }
@media (max-width: 480px) {
  .row { padding-right: 10px; }
  .book { padding: 10px 8px 10px 14px; gap: 10px; }
  .badge { width: 32px; height: 32px; border-radius: 8px; font-size: 11px; }
  /* 窄屏右侧只留两个按钮：词数挪到说明行 */
  .row:has(.usage) .count { display: none; }
  .row:has(.usage) .count-inline { display: inline; }
  .use { min-width: 44px; padding: 0 8px; }
}
</style>

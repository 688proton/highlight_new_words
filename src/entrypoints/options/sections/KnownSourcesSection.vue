<script setup lang="ts">
import { computed } from 'vue';
import { effectiveBookRole, enabledKnownBookIds } from '@/core/known/sources';
import type { BookMeta } from '@/core/wordbook/types';
import { getProviderInfo } from '@/core/source/providers';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { bookDisplayName, bookKindLabel, formatCount, knownBookNote, relativeTime, toggleBookUsage } from '../lib/books';
import { useOptions } from '../lib/context';
import { useSourceIndex } from '../lib/source-index';
import { canAddSourceBook, toggleSourceKnownBook } from '../lib/word-actions';

/**
 * 熟词本来源（追加需求 v3 第 6 条）：本地熟词本始终生效；来源熟词本（欧路“已掌握单词”，或用户把某个远端分组指定为熟词本）
 * 在这里启用/停用，所有启用的熟词本取并集，其中的词不高亮（熟词优先于生词）。
 * 来源熟词本的内容随来源同步更新，只读的（欧路“已掌握”没有写入接口）标注“只读”，“认识”时不能写入。
 * 词书扩充后任意内置书、导入的本地书也能作熟词本（在词书页点“熟词”），这里列出并可移出；
 * 难度/词频分级作熟词本是“低于该档”，显示 knownName（如“A1–B1（B2 以下）”）。
 */
const { settings, books, navigate } = useOptions();
const { states } = useSourceIndex();
const props = defineProps<{ localCount: number }>();

const sourceKnown = computed(() =>
  states.value
    .filter((s) => effectiveBookRole(s, settings.value) === 'known')
    .map((s) => ({
      state: s,
      provider: getProviderInfo(s.providerId)?.name ?? s.providerId,
      on: settings.value.knownBooks.enabled.includes(s.id),
      writable: canAddSourceBook(s),
    })),
);

/** 作熟词本的内置书与本地书（生效的，见 core/known/sources.ts#isEffectiveKnownBook） */
const bookKnown = computed(() =>
  enabledKnownBookIds(settings.value, books.value)
    .map((id) => books.value.find((b) => b.id === id))
    .filter((b): b is BookMeta => !!b && b.kind !== 'source'),
);
/** 移出熟词本：只关“熟词”这一项（ladder 书作生词本的那一档不受影响） */
function removeKnown(b: BookMeta) {
  toggleBookUsage(settings.value, b, 'known', books.value);
}
</script>

<template>
  <SettingsSection id="known-sources" title="熟词本" description="所有启用的熟词本合在一起生效，其中的词不会被高亮（优先于生词本）" flush>
    <ul class="list">
      <li>
        <span class="ico local"><AppIcon name="known" :size="20" /></span>
        <div class="info">
          <strong>本地熟词本</strong>
          <span class="muted">{{ formatCount(props.localCount) }} 词 · 卡片上点“认识”默认写入这里，可随同步跨设备</span>
        </div>
        <span class="badge ok">始终生效</span>
      </li>
      <li v-for="k in sourceKnown" :key="k.state.id">
        <span class="ico">{{ k.provider.slice(0, 1) }}</span>
        <div class="info">
          <div class="line">
            <strong>{{ k.state.name }}</strong>
            <span class="badge">{{ k.provider }}</span>
            <span v-if="!k.writable" class="badge muted" :title="k.state.readOnlyReason">只读</span>
          </div>
          <span class="muted">
            {{ formatCount(k.state.wordCount) }} 词 · {{ k.state.lastSyncAt ? '同步于 ' + relativeTime(k.state.lastSyncAt) : '从未同步' }}
          </span>
          <span v-if="!k.writable" class="muted small">{{ k.state.readOnlyReason ?? '只读：内容随来源同步，“认识”时不能写入' }}</span>
          <span v-if="k.state.status === 'error' && k.state.error" class="err">{{ k.state.error }}</span>
        </div>
        <ToggleSwitch :model-value="k.on" :aria-label="'启用熟词本 ' + k.state.name" @update:model-value="(v: boolean) => toggleSourceKnownBook(settings, k.state.id, v)" />
      </li>
      <li v-for="b in bookKnown" :key="b.id">
        <span class="ico book" :class="b.kind">{{ bookKindLabel(b).slice(0, 2) }}</span>
        <div class="info">
          <strong>{{ b.knownName ?? bookDisplayName(b) }}</strong>
          <span class="muted">{{ knownBookNote(b) }}</span>
        </div>
        <button type="button" class="remove" :aria-label="'移出熟词本 ' + b.name" title="移出熟词本" @click="removeKnown(b)"><AppIcon name="close" :size="18" /></button>
      </li>
    </ul>
    <p v-if="!sourceKnown.length" class="tip muted">
      欧路词典填写 OpenAPI token 后，会把“已掌握单词”同步为只读熟词本；任何远端分组也可以在生词本页把“用作”改为熟词本。
    </p>
    <div class="foot">
      <button type="button" class="link" @click="navigate('books', 'cat-exam')"><AppIcon name="plus" :size="16" />从词书中添加熟词本</button>
      <button type="button" class="link" @click="navigate('sources', 'providers')"><AppIcon name="cloud" :size="16" />管理来源与分组用途</button>
      <button type="button" class="link" @click="navigate('sources', 'word-actions')"><AppIcon name="edit" :size="16" />“认识”时写入哪些熟词本</button>
    </div>
  </SettingsSection>
</template>

<style scoped>
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-top: 1px solid var(--border); min-height: 60px; }
.ico { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: none; background: #1e6fd9; color: #fff; font-weight: 800; }
.ico.local { background: var(--accent-soft); color: var(--accent); }
.ico.book { font-size: 11px; font-weight: 700; background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
.remove { width: 40px; height: 40px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; flex: none; }
.remove:hover { background: var(--surface-2); color: var(--text); }
@media (pointer: coarse) { .remove { width: 44px; height: 44px; } }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-weight: 600; white-space: nowrap; }
.badge.ok { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
.small { font-size: 12px; }
.err { color: var(--danger); font-size: 12px; }
.tip { margin: 0; padding: 10px 18px; border-top: 1px solid var(--border); font-size: 12px; }
.foot { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 6px 18px 10px; border-top: 1px solid var(--border); }
.link { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--accent); cursor: pointer; min-height: 40px; padding: 0; font-size: 13px; font-weight: 600; }
@media (max-width: 480px) { .list li { padding: 10px 14px; } .tip, .foot { padding-left: 14px; padding-right: 14px; } }
</style>

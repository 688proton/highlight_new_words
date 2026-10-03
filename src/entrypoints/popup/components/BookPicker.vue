<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BookId } from '@/core/settings/schema';
import { singleChoiceKey } from '@/core/wordbook/enable';
import { filterBooksByQuery } from '@/core/wordbook/search';
import type { BookMeta } from '@/core/wordbook/types';
import { formatCount, groupBooks, sourceBookStatus } from '../model';
import type { MarkStyle } from '@/core/theme/themes';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import PopupIcon from './PopupIcon.vue';

/**
 * 词书快速切换（底部抽屉内容）：按类别分组的多选列表，可任意组合。
 * 新启用的词书排在末尾（优先级最低）；调整优先级与词书管理在设置页。
 * 只做生词开关：调用方先用 newBookChoices 过滤掉“仅作熟词本”的书；同 ladder / group 的书（难度、词频分级、计算机三档）组内单选，用单选样式。
 * 词书多（超过 SEARCH_THRESHOLD 本）时顶部显示搜索框。
 */
const props = defineProps<{ books: BookMeta[]; enabled: BookId[]; markOf: (id: BookId) => MarkStyle }>();
const emit = defineEmits<{ toggle: [id: BookId, on: boolean] }>();

/** 超过这个数量才显示搜索框：书少时一屏可见，搜索框反而占位 */
const SEARCH_THRESHOLD = 12;
const query = ref('');
const groups = computed(() => groupBooks(filterBooksByQuery(props.books, query.value)));
const now = Date.now();
</script>

<template>
  <div class="picker" :class="{ searchable: books.length > SEARCH_THRESHOLD }">
    <label v-if="books.length > SEARCH_THRESHOLD" class="search">
      <PopupIcon name="search" :size="16" />
      <input v-model="query" type="search" placeholder="搜索词书" aria-label="搜索词书" />
      <button v-if="query" type="button" class="clear" aria-label="清除搜索" @click="query = ''"><PopupIcon name="close" :size="16" /></button>
    </label>
    <section v-for="g in groups" :key="g.category" class="group">
      <h3>{{ g.title }}</h3>
      <ul>
        <li v-for="b in g.books" :key="b.id">
          <label class="item" :class="{ on: enabled.includes(b.id), radio: !!singleChoiceKey(b) }">
            <input
              type="checkbox"
              :checked="enabled.includes(b.id)"
              @change="emit('toggle', b.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="box" aria-hidden="true"><PopupIcon name="check" :size="14" /></span>
            <span class="info">
              <span class="name">{{ b.name }}</span>
              <span class="meta">
                <span>{{ formatCount(b.size) }} 词</span>
                <template v-if="sourceBookStatus(b, now)">
                  <span class="sep">·</span>
                  <span :class="`tone-${sourceBookStatus(b, now)!.tone}`">{{ sourceBookStatus(b, now)!.text }}</span>
                </template>
                <!-- 内置词书不再显示英文名（“Zhongkao”是拼音，对用户没有信息量） -->
              </span>
            </span>
            <span v-if="enabled.includes(b.id)" class="prio" :title="`优先级第 ${enabled.indexOf(b.id) + 1}`">
              <MarkPreview :mark="markOf(b.id)" word="Aa" />
              <small>#{{ enabled.indexOf(b.id) + 1 }}</small>
            </span>
          </label>
        </li>
      </ul>
    </section>
    <p v-if="!groups.length" class="empty">{{ query ? '没有匹配的词书' : '词书加载中…' }}</p>
  </div>
</template>

<style scoped>
.group + .group { margin-top: 12px; }
h3 { margin: 4px 0 6px; font-size: 12px; font-weight: 600; color: var(--text-2); letter-spacing: .04em; }
ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
.item { position: relative; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 12px; cursor: pointer; background: var(--surface); }
.item:hover { background: var(--surface-2); }
/* 只隐藏列表项里的原生复选框（由 .box 画样式）；不能写成裸 input，否则会把顶部搜索框也一起隐藏 */
.item input[type=checkbox] { position: absolute; opacity: 0; width: 1px; height: 1px; }
.box {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; flex: none;
  border: 2px solid var(--border); color: transparent; transition: background .12s, border-color .12s;
}
.item.on .box { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
/* 组内单选（难度、词频分级等）：圆形单选样式 */
.item.radio .box { border-radius: 50%; }
.item.radio.on .box { background: var(--surface); border: 6px solid var(--accent); color: transparent; }
.search { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-2); }
.search input { position: static; opacity: 1; flex: 1; width: auto; min-width: 0; min-height: 44px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; outline: none; }
.search input::placeholder { color: var(--text-2); }
/* 用自带的清除按钮（与设置页一致），隐藏浏览器原生的蓝色 × */
.search input::-webkit-search-cancel-button { display: none; }
.clear { flex: none; display: grid; place-items: center; width: 36px; height: 36px; margin-right: -6px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--text-2); cursor: pointer; }
.clear:hover { background: var(--surface-2); color: var(--text); }
@media (pointer: coarse) { .clear { width: 44px; height: 44px; margin-right: -10px; } }
/* 有搜索框时给列表保底高度：筛选后结果变少，抽屉不跟着缩矮，避免输入框随打字上下跳 */
.picker.searchable { min-height: 55vh; }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
input:focus-visible + .box { outline: 2px solid var(--accent); outline-offset: 2px; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; gap: 4px; color: var(--text-2); font-size: 12px; min-width: 0; }
.meta > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sep { opacity: .6; }
.prio { flex: none; display: flex; flex-direction: column; align-items: center; font-weight: 650; font-size: 13px; line-height: 1.2; }
.prio small { font-size: 10px; color: var(--text-2); font-weight: 500; }
.tone-ok { color: var(--text-2); }
.tone-warn { color: #b45309; }
.tone-error { color: var(--danger); }
.tone-busy { color: var(--accent); }
.empty { color: var(--text-2); text-align: center; padding: 24px 0; }
@media (prefers-color-scheme: dark) { .tone-warn { color: #fbbf24; } }
</style>

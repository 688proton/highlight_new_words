import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createDefaultSettings } from '@/core/settings/defaults';
import { MY_WORDS_BOOK_ID, type Settings } from '@/core/settings/schema';
import { packagedBuiltinMetas } from '@/core/wordbook/packaged-catalog';
import type { BookMeta } from '@/core/wordbook/types';
import { quickBookChips } from '@/content/floatball/model';
import { provideOptions } from '@/entrypoints/options/lib/context';
import BooksPage from '@/entrypoints/options/pages/BooksPage.vue';
import WelcomeGuide from '@/entrypoints/options/pages/WelcomeGuide.vue';
import KnownSourcesSection from '@/entrypoints/options/sections/KnownSourcesSection.vue';
import BookPicker from '@/entrypoints/popup/components/BookPicker.vue';

/**
 * 词书三态界面（词书页、首次引导、熟词页、popup 词书抽屉、悬浮球快捷设置）的组件测试：
 * 用打包目录的真实内置书元数据，在 jsdom 中挂载 .vue 组件。
 */

const builtin = packagedBuiltinMetas();
const local = (id: string, name: string): BookMeta =>
  ({ id, kind: 'local', name, nameEn: name, short: '本地', category: 'user', level: 0, size: 12, source: '导入自 words.txt', updatedAt: 1 }) as BookMeta;
const ALL: BookMeta[] = [local(MY_WORDS_BOOK_ID, '我的生词本'), local('local:abc', '托福错词'), ...builtin];

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // jsdom 下可用，这里只是保险
  }
});

/** 在 options 上下文中挂载组件 */
function mount(comp: unknown, opts: { settings?: Settings; books?: BookMeta[]; props?: Record<string, unknown>; nav?: string[] } = {}) {
  const settings = ref<Settings>(opts.settings ?? createDefaultSettings());
  settings.value.books.enabled = opts.settings ? settings.value.books.enabled : [];
  const books = ref<BookMeta[]>(opts.books ?? ALL);
  const el = document.createElement('div');
  document.body.append(el);
  const Root = defineComponent({
    setup() {
      provideOptions({ settings, books, navigate: (p, a) => opts.nav?.push(a ? `${p}/${a}` : p) });
      return () => h(comp as never, opts.props ?? {});
    },
  });
  const app = createApp(Root);
  app.mount(el);
  cleanup.push(() => {
    app.unmount();
    el.remove();
  });
  return { el, settings };
}
const flush = async () => {
  await nextTick();
  await nextTick();
};
/** 找到某本书所在行（按 aria-label 中的书名） */
function rowButtons(el: HTMLElement, name: string) {
  const known = el.querySelector<HTMLButtonElement>(`button[aria-label="作熟词本 ${name}"]`);
  const fresh = el.querySelector<HTMLButtonElement>(`button[aria-label="作生词本 ${name}"]`);
  if (!known || !fresh) throw new Error('找不到词书行：' + name);
  return { known, fresh, row: known.closest('li')! };
}
const sectionIds = (el: HTMLElement) => [...el.querySelectorAll('section')].map((s) => s.id);

describe('词书页：分组、三态切换', () => {
  it('分组顺序：正在使用 → 我的词书 → 难度 → 考试 → 词频 → 通用核心词 → 专业领域', () => {
    const { el } = mount(BooksPage);
    expect(sectionIds(el)).toEqual(['enabled', 'mine', 'cat-level', 'cat-exam', 'cat-frequency', 'cat-core', 'cat-domain']);
  });

  it('点“熟词”：考试书进熟词本、不在生词本；再点“生词”互斥切回', async () => {
    const { el, settings } = mount(BooksPage);
    const cet4 = builtin.find((b) => b.id === 'cet4')!;
    rowButtons(el, cet4.name).known.click();
    await flush();
    expect(settings.value.knownBooks.enabled).toContain('cet4');
    expect(settings.value.books.enabled).not.toContain('cet4');
    let r = rowButtons(el, cet4.name);
    expect(r.known.getAttribute('aria-pressed')).toBe('true');
    expect(r.fresh.getAttribute('aria-pressed')).toBe('false');
    expect(r.row.textContent).toContain('作熟词本');
    // 正在使用 · 熟词本列出它
    expect(el.querySelector('#enabled')!.textContent).toContain(cet4.name);
    r.fresh.click();
    await flush();
    expect(settings.value.books.enabled).toContain('cet4');
    expect(settings.value.knownBooks.enabled).not.toContain('cet4');
    r = rowButtons(el, cet4.name);
    expect(r.known.getAttribute('aria-pressed')).toBe('false');
  });

  it('ladder 书：同一档两表可同时选，各表组内单选；熟词显示 knownName（低于该档）', async () => {
    const { el, settings } = mount(BooksPage);
    const b2 = builtin.find((b) => b.id === 'cefr-b2')!;
    const b1 = builtin.find((b) => b.id === 'cefr-b1')!;
    rowButtons(el, b2.name).fresh.click();
    rowButtons(el, b2.name).known.click();
    await flush();
    expect(settings.value.books.enabled).toEqual(['cefr-b2']);
    expect(settings.value.knownBooks.enabled).toEqual(['cefr-b2']);
    rowButtons(el, b1.name).known.click();
    await flush();
    expect(settings.value.knownBooks.enabled).toEqual(['cefr-b1']);
    expect(settings.value.books.enabled).toEqual(['cefr-b2']);
    expect(el.querySelector('#enabled')!.textContent).toContain(b1.knownName!);
    expect(el.querySelector('#enabled')!.textContent).toContain(`由“${b1.name}”设置 · 这些词不再高亮`);
    // ladder 组不提供全选，并给出包含关系提示
    const level = el.querySelector('#cat-level')!;
    expect(level.textContent).not.toContain('全选');
    expect(level.textContent).toContain('熟词选一档 = 低于该档');
  });

  it('整行点击切换生词；我的生词本的熟词按钮禁用并说明原因', async () => {
    const { el, settings } = mount(BooksPage);
    const mine = rowButtons(el, '我的生词本');
    expect(mine.known.disabled).toBe(true);
    expect(mine.known.title).toContain('不能作熟词本');
    mine.row.querySelector<HTMLButtonElement>('button.book')!.click();
    await flush();
    expect(settings.value.books.enabled).toContain(MY_WORDS_BOOK_ID);
  });

  it('本地书设为熟词本：从“加入生词本时写入”目标中移除', async () => {
    const s = createDefaultSettings();
    s.books.enabled = [];
    s.wordActions.addTargets = [MY_WORDS_BOOK_ID, 'local:abc'];
    const { el, settings } = mount(BooksPage, { settings: s });
    rowButtons(el, '托福错词').known.click();
    await flush();
    expect(settings.value.knownBooks.enabled).toContain('local:abc');
    expect(settings.value.wordActions.addTargets).toEqual([MY_WORDS_BOOK_ID]);
  });

  it('新书显示许可；计算机三档按单选样式', () => {
    const { el } = mount(BooksPage);
    const ngsl = builtin.find((b) => b.id === 'ngsl')!;
    expect(rowButtons(el, ngsl.name).row.textContent).toContain('CC BY-SA 4.0 · NGSL Project');
    const cs = builtin.find((b) => b.id === 'cs-500')!;
    expect(rowButtons(el, cs.name).row.querySelector('button.book')!.getAttribute('role')).toBe('radio');
  });
});

describe('词书页：搜索、筛选、折叠', () => {
  const setQuery = async (el: HTMLElement, q: string) => {
    const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = q;
    input.dispatchEvent(new Event('input'));
    await flush();
  };

  it('搜索归一化（cet-6 / 六级 / 数字），只显示命中组且隐藏“正在使用”', async () => {
    const { el } = mount(BooksPage);
    await setQuery(el, 'CET 6');
    expect(sectionIds(el)).toEqual(['cat-exam']);
    expect(el.querySelector('#cat-exam')!.textContent).toContain('大学英语六级');
    await setQuery(el, '3000');
    expect(sectionIds(el)).toContain('cat-frequency');
    await setQuery(el, '医学');
    expect(sectionIds(el)).toEqual(['cat-domain']);
    // 名称等身份字段有命中时不再列出只在说明里顺带提到的书（C1、考研新增等说明里有“六级”）
    await setQuery(el, '六级');
    expect(sectionIds(el)).toEqual(['cat-exam']);
    const exam = el.querySelector('#cat-exam')!.textContent!;
    expect(exam).toContain('六级新增');
    expect(exam).not.toContain('考研新增');
    // 身份字段全无命中时退到说明：仍能搜到
    await setQuery(el, '已掌握');
    expect(sectionIds(el)).toEqual(['cat-level']);
  });

  it('无结果显示空态，清除按钮恢复', async () => {
    const { el } = mount(BooksPage);
    await setQuery(el, 'zzzz-not-a-book');
    expect(el.textContent).toContain('没有匹配的词书');
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('清除搜索与筛选'))!.click();
    await flush();
    expect(el.textContent).not.toContain('没有匹配的词书');
    expect(sectionIds(el)).toContain('enabled');
  });

  it('筛选“熟词本”只列熟词本中的书', async () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cet6'];
    s.knownBooks.enabled = ['cet4'];
    const { el } = mount(BooksPage, { settings: s });
    [...el.querySelectorAll<HTMLButtonElement>('.filters button')].find((b) => b.textContent?.trim() === '熟词本')!.click();
    await flush();
    const names = [...el.querySelectorAll('.list .name')].map((n) => n.textContent);
    expect(names).toEqual([builtin.find((b) => b.id === 'cet4')!.name]);
  });

  it('组可折叠并记住，搜索时强制展开', async () => {
    const { el } = mount(BooksPage);
    el.querySelector<HTMLButtonElement>('#cat-core button.fold')!.click();
    await flush();
    expect(el.querySelector('#cat-core .list')).toBeNull();
    expect(JSON.parse(localStorage.getItem('hnw.books.collapsed')!)).toEqual(['core']);
    await setQuery(el, 'ngsl');
    expect(el.querySelector('#cat-core .list')).not.toBeNull();
  });
});

describe('首次引导与熟词页', () => {
  it('引导只展示难度、考试、词频三组，ladder 书单选样式', () => {
    // 引导页顶部的站点授权横幅会查权限，fake-browser 没实现
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    vi.spyOn(fakeBrowser.permissions.onAdded, 'addListener').mockImplementation((() => {}) as never);
    vi.spyOn(fakeBrowser.permissions.onRemoved, 'addListener').mockImplementation((() => {}) as never);
    vi.spyOn(fakeBrowser.permissions.onAdded, 'removeListener').mockImplementation((() => {}) as never);
    vi.spyOn(fakeBrowser.permissions.onRemoved, 'removeListener').mockImplementation((() => {}) as never);
    const { el } = mount(WelcomeGuide);
    const titles = [...el.querySelectorAll('.group-title')].map((t) => t.textContent);
    expect(titles.map((t) => t!.replace(/（.*）/, ''))).toEqual(['难度分级', '考试词书', '词频分级']);
    expect(el.textContent).not.toContain('NGSL');
    const b2 = [...el.querySelectorAll('.card')].find((c) => c.textContent?.includes('B2'))!;
    expect(b2.getAttribute('role')).toBe('radio');
  });

  it('熟词页列出内置书熟词本（ladder 显示 knownName），可移出；可跳词书页添加', async () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cefr-b2'];
    s.knownBooks.enabled = ['cefr-b2', 'cet4'];
    const nav: string[] = [];
    const { el, settings } = mount(KnownSourcesSection, { settings: s, props: { localCount: 3 }, nav });
    const b2 = builtin.find((b) => b.id === 'cefr-b2')!;
    expect(el.textContent).toContain(b2.knownName!);
    // 说明行与词书页“正在使用→熟词本”同一文案（knownBookNote）
    expect(el.textContent).toContain(`由“${b2.name}”设置 · 这些词不再高亮`);
    el.querySelector<HTMLButtonElement>(`button[aria-label="移出熟词本 ${b2.name}"]`)!.click();
    await flush();
    expect(settings.value.knownBooks.enabled).toEqual(['cet4']);
    // ladder 书移出熟词本不影响生词本那一档
    expect(settings.value.books.enabled).toEqual(['cefr-b2']);
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('从词书中添加熟词本'))!.click();
    expect(nav[0]).toMatch(/^books/);
  });
});

describe('popup 词书抽屉、悬浮球快捷设置', () => {
  it('BookPicker 书多时显示搜索框并过滤；ladder 行单选样式', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const app = createApp(BookPicker, { books: builtin, enabled: ['cefr-b2'], markOf: () => ({}) });
    app.mount(el);
    cleanup.push(() => {
      app.unmount();
      el.remove();
    });
    const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
    expect(input).not.toBeNull();
    expect(el.querySelector('.item.radio.on')).not.toBeNull();
    input.value = '六级';
    input.dispatchEvent(new Event('input'));
    await flush();
    const names = [...el.querySelectorAll('.name')].map((n) => n.textContent);
    // 名称、keywords 命中“六级”的优先，只在说明里提到“六级”的（考研新增、C1）不列出，四级也不在其中
    expect(names).toContain('大学英语六级');
    expect(names).toContain('六级新增');
    expect(names).not.toContain('考研新增');
    expect(names).not.toContain('C1 高级');
    expect(names).not.toContain('大学英语四级');
  });

  it('BookPicker 隐藏原生复选框的样式只作用于复选框，不能连带隐藏搜索框', () => {
    // 组件测试环境不注入 SFC 样式，这里静态检查 <style>：所有 opacity:0 / position:absolute 的 input 规则都必须限定到复选框
    const sfc = readFileSync(resolve(__dirname, '../../src/entrypoints/popup/components/BookPicker.vue'), 'utf8');
    const css = sfc.slice(sfc.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1]!, body: m[2]!.trim() }))
      .filter(({ sel, body }) => /\binput\b/.test(sel) && /opacity:\s*0\s*(;|$)|position:\s*absolute/.test(body));
    expect(hiding.length).toBeGreaterThan(0);
    for (const { sel } of hiding) for (const part of sel.split(',')) expect(part).toContain('[type=checkbox]');
    // 搜索框自身显式可见，触屏高度 ≥ 44px
    const searchRule = css.match(/\.search input\s*\{([^}]*)\}/)![1];
    expect(searchRule).toMatch(/opacity:\s*1/);
    expect(searchRule).toMatch(/position:\s*static/);
    expect(searchRule).toMatch(/min-height:\s*44px/);
  });

  it('quickBookChips：已启用在前，过滤仅作熟词本的书，只列难度/考试/词频，其余用“全部词书…”', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['ngsl', 'cet6'];
    s.knownBooks.enabled = ['cet4'];
    const { chips, more } = quickBookChips(s, ALL);
    const ids = chips.map((b) => b.id);
    expect(ids.slice(0, 2)).toEqual(['ngsl', 'cet6']);
    expect(ids).not.toContain('cet4');
    expect(ids).not.toContain('nawl');
    expect(ids).not.toContain(MY_WORDS_BOOK_ID);
    expect(ids).toContain('cefr-b2');
    expect(more).toBe(true);
  });
});

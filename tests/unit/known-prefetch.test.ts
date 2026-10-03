import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultSettings } from '@/core/settings/defaults';
import { STORAGE_KEYS } from '@/core/storage/keys';
import type { BookCatalog, CatalogBookMeta } from '@/core/wordbook/types';

/**
 * 内容脚本首屏预取：ladder 书作熟词本时只请求补集文件（base + 更低各档），不请求该档自身文件；
 * 目录打包内联（不 fetch），熟词本要的文件与生词本文件在读到设置后同时发出，不多一次串行往返。
 */

vi.mock('@/content/sites/context', () => ({ startPageExtras: () => ({ settingsChanged() {} }) }));
const fixtures = vi.hoisted(() => {
  const cat = (id: string, extra: Record<string, unknown>) => ({ id, name: id, nameEn: id, short: id, category: 'level', level: 1, size: 1, ...extra });
  return {
    catalog: {
      version: 3,
      books: [
        cat('cefr-a2', { level: 2, ladder: 'cefr' }),
        cat('cefr-b1', { level: 3, ladder: 'cefr' }),
        cat('cefr-b2', { level: 4, ladder: 'cefr' }),
        cat('gk', { category: 'exam', level: 2 }),
        cat('cet6', { category: 'exam', level: 5 }),
      ] as CatalogBookMeta[],
      ladders: { cefr: { base: 'cefr-a1' } },
    } satisfies BookCatalog,
  };
});
vi.mock('@/core/wordbook/packaged-catalog', () => ({ PACKAGED_CATALOG: fixtures.catalog }));

/** 每次 fetch 延迟 fetchMs、每次 storage 读延迟 storageMs，记录每个词书文件的发出时刻 */
function stubIo(fetchMs: number, storageMs: number) {
  const started = new Map<string, number>();
  const t0 = performance.now();
  const get = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
  vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementation((async (keys: never) => {
    await new Promise((r) => setTimeout(r, storageMs));
    return get(keys);
  }) as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url).replace(/^.*?data\//, 'data/');
      const m = /^data\/books\/(.+)\.json$/.exec(path);
      if (m) started.set(m[1]!, performance.now() - t0);
      await new Promise((r) => setTimeout(r, fetchMs));
      return new Response(JSON.stringify(m ? { id: m[1], words: [`${m[1]}-word`] } : {}));
    }),
  );
  return started;
}

describe('内容脚本：熟词内置书进首屏预取', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cefr-b2 + gk 作熟词本：补集 a1/a2/b1 与 gk 和生词本 cet6 同时发出，不请求 cefr-b2 自身文件与目录', async () => {
    vi.resetModules();
    fakeBrowser.reset();
    const s = createDefaultSettings();
    s.books.enabled = ['cet6'];
    s.knownBooks.enabled = ['cefr-b2', 'gk'];
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: s });
    const started = stubIo(40, 5);
    const { startContentApp } = await import('@/content/app');
    await startContentApp();
    await vi.waitFor(() => expect(started.has('cefr-b1')).toBe(true));
    expect([...started.keys()].sort()).toEqual(['cefr-a1', 'cefr-a2', 'cefr-b1', 'cet6', 'gk']);
    // 全部文件在同一时刻发出（读到设置后同步预取）：与生词本文件的发出时间差远小于一次 fetch（40ms）
    const newAt = started.get('cet6')!;
    for (const [id, at] of started) expect(Math.abs(at - newAt), id).toBeLessThan(10);
  });
});

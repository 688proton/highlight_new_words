import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompositeDictionary, PackagedDictionary, parseForms } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';
import { createUserWordBook, UserBooksDictionary } from '@/core/wordbook/user-book';
import { DefaultWordBookRegistry, localBookMeta, type RegistryLoaders } from '@/core/wordbook/registry';
import type { BookCatalog, BookDataFile, CatalogBookMeta } from '@/core/wordbook/types';
import { isCleanVerbShort, parseVerbOverrides } from '../../scripts/data/verb-short.mjs';

/**
 * data 分片单测：registry 的嵌套词书加载、打包词典两层懒加载，以及 public/data 产物的完整性与“常用词误报”回归。
 * 产物由 scripts/data/build-data.mjs 生成，改动构建规则后需重新生成并通过本测试。
 */

const DATA = path.resolve(__dirname, '../../public/data');
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')) as T;

const catalogMeta = (id: string, size = 0): CatalogBookMeta => ({ id, name: id, nameEn: id, short: id, category: 'level', level: 1, size });

function memoryLoaders(catalog: BookCatalog, files: Record<string, BookDataFile>): RegistryLoaders & { book: ReturnType<typeof vi.fn> } {
  return {
    catalog: async () => catalog,
    book: vi.fn(async (id: string) => {
      const f = files[id];
      if (!f) throw new Error('404 ' + id);
      return f;
    }),
    sourceIndex: async () => ({ books: {}, providers: {} }),
    sourceBook: async () => undefined,
    localIndex: async () => ({ books: {}, removed: {} }),
    localBook: async () => undefined,
  };
}

describe('DefaultWordBookRegistry 嵌套词书（extends）', () => {
  const files: Record<string, BookDataFile> = {
    c2: { id: 'c2', words: ['obfuscate'] },
    c1: { id: 'c1', words: ['scrutinize'], extends: ['c2'] },
    b2: { id: 'b2', words: ['vulnerable'], extends: ['c1'] },
    loop: { id: 'loop', words: ['x'], extends: ['loop'] },
  };
  const catalog: BookCatalog = { version: 2, books: ['c2', 'c1', 'b2', 'loop'].map((id) => catalogMeta(id)) };

  it('递归合并 extends 的词，共享文件只加载一次', async () => {
    const loaders = memoryLoaders(catalog, files);
    const reg = new DefaultWordBookRegistry(loaders);
    const [b2, c1] = await Promise.all([reg.load('b2'), reg.load('c1')]);
    expect([...b2!.words()].sort()).toEqual(['obfuscate', 'scrutinize', 'vulnerable']);
    expect(b2!.has('obfuscate')).toBe(true);
    expect(c1!.size).toBe(2);
    expect(loaders.book.mock.calls.map((c) => c[0]).filter((id) => id === 'c2')).toHaveLength(1);
  });

  it('循环引用不死循环', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders(catalog, files));
    expect((await reg.load('loop'))!.size).toBe(1);
  });
});

describe('PackagedDictionary 两层分片', () => {
  const shards: Record<string, DictShardFile> = {
    w: { width: { p: 'widθ', s: '宽度', g: 'cet4 cet6', l: 4, r: 6752 } },
    'full/w': { width: { f: 'n. 宽度, 宽广', x: 's:widths' } },
    // 旧格式：f 直接在短表中
    o: { old: { s: '旧的', f: 'a. 旧的, 老的' } },
  };

  it('lookupMany 只读短表，lookup 补齐完整释义与词形', async () => {
    const load = vi.fn(async (p: string) => shards[p] ?? {});
    const dict = new PackagedDictionary(load);
    const many = await dict.lookupMany(['Width', 'nope']);
    expect(many.get('width')).toMatchObject({ short: '宽度', full: '宽度', tags: ['cet4', 'cet6'], level: 4, rank: 6752 });
    expect(many.has('nope')).toBe(false);
    expect(load.mock.calls.map((c) => c[0])).not.toContain('full/w');

    const one = await dict.lookup('width');
    expect(one).toMatchObject({ full: 'n. 宽度, 宽广', forms: [{ type: 's', word: 'widths' }] });
    expect((await dict.lookup('old'))?.full).toBe('a. 旧的, 老的');
  });

  it('parseForms 只保留屈折类型并展开多个词形', () => {
    expect(parseForms('p:went/d:gone/0:go/i:going,goin')).toEqual([
      { type: 'p', word: 'went' },
      { type: 'd', word: 'gone' },
      { type: 'i', word: 'going' },
      { type: 'i', word: 'goin' },
    ]);
    expect(parseForms('')).toBeUndefined();
  });

  it('CompositeDictionary.lookup：用户词书释义优先，打包词典补齐级别/词形', async () => {
    const packaged = new PackagedDictionary(async (p) => shards[p] ?? {});
    const meta = localBookMeta({ id: 'local:1', name: 't', format: 'txt', wordCount: 1, createdAt: 0, updatedAt: 0 });
    const user = new UserBooksDictionary([createUserWordBook(meta, { width: { word: 'width', trans: '宽' } })]);
    const e = await new CompositeDictionary([user, packaged]).lookup('width');
    expect(e).toMatchObject({ short: '宽', level: 4, forms: [{ type: 's', word: 'widths' }] });
  });
});

// ---------------------------------------------------------------------------
// 产物完整性
// ---------------------------------------------------------------------------

const catalog = readJson<BookCatalog>('books/index.json');
const fileCache = new Map<string, BookDataFile>();
const bookFile = (id: string) => {
  let f = fileCache.get(id);
  if (!f) {
    f = readJson<BookDataFile>(`books/${id}.json`);
    fileCache.set(id, f);
  }
  return f;
};
/** 与 registry 相同的合并规则 */
function bookWords(id: string): Set<string> {
  const f = bookFile(id);
  return new Set([...f.words, ...(f.extends ?? []).flatMap((p) => [...bookWords(p)])]);
}
const shortShard = (c: string) => readJson<DictShardFile>(`dict/${c}.json`);
const dictShort = new Map<string, DictShardFile>();
function dictEntry(w: string) {
  const c = w[0]!;
  if (!dictShort.has(c)) dictShort.set(c, shortShard(c));
  return dictShort.get(c)![w];
}

describe('public/data 产物', () => {
  it('目录：id 唯一、文件存在、size 与合并后词数一致、分类合法', () => {
    const ids = catalog.books.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of catalog.books) {
      expect(['level', 'exam', 'frequency', 'core', 'domain', 'other']).toContain(b.category);
      expect(bookFile(b.id).id).toBe(b.id);
      expect(bookWords(b.id).size, b.id).toBe(b.size);
      expect(b.description, b.id).toBeTruthy();
    }
    // 默认启用的 cet6 必须存在；考试书覆盖需求列出的全部考试
    for (const id of ['zk', 'gk', 'cet4', 'cet6', 'kaoyan', 'toefl', 'ielts', 'gre', 'sat', 'cet6-new', 'cefr-b2', 'coca-5k']) expect(ids).toContain(id);
  });

  it('词书文件：小写纯字母、已排序、不重复，嵌套书只存差集', () => {
    for (const b of catalog.books) {
      const { words, extends: ext } = bookFile(b.id);
      expect(words.every((w) => /^[a-z]+$/.test(w)), b.id).toBe(true);
      expect([...words].sort(), b.id).toEqual(words);
      expect(new Set(words).size, b.id).toBe(words.length);
      for (const p of ext ?? []) {
        const parent = bookWords(p);
        expect(words.some((w) => parent.has(w)), `${b.id} 与 ${p} 重复存储`).toBe(false);
      }
    }
  });

  it('级别是包含体系：B2 ⊃ C1 ⊃ C2，B2 不含 A1–B1 词', () => {
    const b2 = bookWords('cefr-b2');
    const c1 = bookWords('cefr-c1');
    expect([...c1].every((w) => b2.has(w))).toBe(true);
    for (const w of ['vulnerable', 'infrastructure', 'pessimistic', 'dilemma']) expect(b2.has(w), w).toBe(true);
    for (const w of ['city', 'water', 'people', 'good', 'energy', 'year', 'because']) expect(b2.has(w), w).toBe(false);
  });

  it('增量词书与被减去的考试书不相交', () => {
    for (const b of catalog.books.filter((x) => x.delta)) {
      const words = bookWords(b.id);
      for (const m of b.delta!.minus) {
        const raw = bookWords(m);
        // minus 按原始考试词表（含基础词）计算，去基础词后的考试书是其子集，所以一定不相交
        expect([...words].filter((w) => raw.has(w)), `${b.id} ∩ ${m}`).toEqual([]);
      }
      expect([...words].every((w) => bookWords(b.delta!.of).has(w))).toBe(true);
    }
  });

  it('考试书去掉了基础常用词，且不含变形词/专有名词', () => {
    const cet6 = bookWords('cet6');
    for (const w of ['the', 'and', 'have', 'good', 'people', 'city', 'school', 'cities', 'levels', 'margaret']) expect(cet6.has(w), w).toBe(false);
    for (const w of ['vulnerable', 'premise', 'genuine', 'retreat']) expect(cet6.has(w), w).toBe(true);
    expect(bookWords('ielts').has('cities')).toBe(false);
  });

  it('高频词的屈折形式不作为独立生词（found←find、means←mean、times←time），独立词条保留', () => {
    // 审计：词表把屈折形式当独立词条，页面上多为屈折用法却按罕见义误译（found=创立、times=乘以、provided=假如）。
    // 原形不在本书（低于本书起点或在词频阈值内）时，屈折形式也不收；原形也不在书中，所以页面上整体不高亮
    const DROPPED: Record<string, string[]> = {
      cet6: ['found', 'means', 'remains', 'understanding', 'willing', 'learning', 'saving', 'concerning'],
      'cefr-b2': ['times', 'known', 'expected', 'moving', 'growing', 'related', 'existing', 'proposed', 'found', 'means'],
      'coca-5k': ['times', 'remains', 'paid', 'moving', 'lasting', 'stuck', 'worn', 'known', 'expected'],
      cet4: ['provided', 'found', 'means', 'setting'],
    };
    for (const [id, words] of Object.entries(DROPPED)) {
      const book = bookWords(id);
      expect(words.filter((w) => book.has(w)), id).toEqual([]);
    }
    // 真正独立的词条：没有原形（statistics、headquarters）、比原形常见（media）、或词汇化复数（goods）
    for (const w of ['media', 'statistics', 'headquarters']) expect(bookWords('cet6').has(w), w).toBe(true);
    for (const w of ['media', 'statistics', 'headquarters', 'goods']) expect(bookWords('cet4').has(w), w).toBe(true);
    for (const w of ['media', 'statistics', 'headquarters']) expect(bookWords('cefr-b2').has(w), w).toBe(true);
    // 原形也在本书时屈折形式照常保留（不误伤）：B2 中原形与派生形式都是生词
    expect(bookWords('cefr-b2').has('vulnerable')).toBe(true);
  });

  it('词典覆盖所有内置词书的词，行内短释义 ≤ 8 字且不带词性', () => {
    const missing: string[] = [];
    let noShort = 0;
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    for (const w of all) {
      const e = dictEntry(w);
      if (!e) missing.push(w);
      else if (!e.s) noShort++;
      else {
        expect(e.s.length, w).toBeLessThanOrEqual(8);
        expect(e.s, w).not.toMatch(/^[a-z]+\./);
      }
    }
    expect(missing).toEqual([]);
    expect(noShort).toBeLessThan(10);
    expect(dictEntry('abandon')?.s).toBe('放弃');
    expect(dictEntry('scrutinize')).toMatchObject({ l: 5 });
  });
});

// ---------------------------------------------------------------------------
// 包含体系（ladder）与外部词表新书（NGSL 系列、MOEL、计算机 TWLRACS）
// ---------------------------------------------------------------------------

describe('ladder 与 catalog 新字段', () => {
  it('cefr/coca 两组：成员带 ladder 与 knownName，base 文件存在且不在 books 列表中', () => {
    expect(catalog.ladders).toEqual({ cefr: { base: 'cefr-a1' }, coca: { base: 'coca-top' } });
    const ids = new Set(catalog.books.map((b) => b.id));
    for (const [ladder, { base }] of Object.entries(catalog.ladders!)) {
      expect(ids.has(base!), base!).toBe(false);
      const f = bookFile(base!);
      expect(f.id).toBe(base);
      expect(f.extends).toBeUndefined();
      expect(f.words.every((w) => /^[a-z]+$/.test(w))).toBe(true);
      expect([...f.words].sort()).toEqual(f.words);
      const members = catalog.books.filter((b) => b.ladder === ladder);
      expect(members.length, ladder).toBeGreaterThanOrEqual(4);
      for (const b of members) expect(b.knownName, b.id).toBeTruthy();
    }
    for (const b of catalog.books) expect(Boolean(b.ladder), b.id).toBe(b.category === 'level' || b.category === 'frequency');
    const meta = (id: string) => catalog.books.find((b) => b.id === id)!;
    expect(meta('cefr-b2').knownName).toBe('A1–B1（B2 以下）');
    expect(meta('cefr-a2').knownName).toBe('A1（A2 以下）');
    expect(meta('coca-3k').knownName).toBe('常用前 3000 词及 A1–A2 词');
  });

  it('base 文件与该组最低档互补：cefr-a1 是 A1 入门词，coca-top 是常用前 3000 词', () => {
    const a1 = bookWords('cefr-a1');
    const a2 = bookWords('cefr-a2');
    expect(a1.size).toBeGreaterThan(800);
    expect(a1.size).toBeLessThan(1500);
    expect([...a1].filter((w) => a2.has(w))).toEqual([]);
    for (const w of ['apple', 'water', 'city', 'good', 'because']) expect(a1.has(w), w).toBe(true);
    const top = bookWords('coca-top');
    const k3 = bookWords('coca-3k');
    expect(top.size).toBeGreaterThan(3000);
    expect(top.size).toBeLessThan(4500);
    expect([...top].filter((w) => k3.has(w))).toEqual([]);
    for (const w of ['people', 'year', 'government', 'money']) expect(top.has(w), w).toBe(true);
  });

  it('base 文件盖住最低档之下的全部词：任何内置书里词频前 3000 的词都在 coca-top，CEFR-J A1 词都在 cefr-a1', () => {
    // 回归：coca-top 曾只取 inventory（levelOf）内的词，core/conservative/monday 等不在其中，
    // 熟词选“常用前 3000 词”时它们仍被 cet4 等书高亮；cefr-a1 曾缺星期/月份/i（ECDICT 词条首字母大写被当作专名）
    const top = bookWords('coca-top');
    const a1 = bookWords('cefr-a1');
    const allBookWords = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    const uncovered = [...allBookWords].filter((w) => (dictEntry(w)?.r ?? Infinity) <= 3000 && !top.has(w));
    expect(uncovered).toEqual([]);
    const DAYS_MONTHS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (const w of ['core', 'conservative', 'christian', 'north', 'soviet', 'olympic', 'pole', 'god', 'i', ...DAYS_MONTHS]) expect(top.has(w), w).toBe(true);
    for (const w of ['i', ...DAYS_MONTHS]) expect(a1.has(w), w).toBe(true);
    // 词典条目带级别 l=1 的词全部在 cefr-a1
    const levelA1 = [...allBookWords, ...a1].filter((w) => dictEntry(w)?.l === 1);
    expect(levelA1.filter((w) => !a1.has(w))).toEqual([]);
  });

  it('搜索别名：考试书中英都有（cet6 → 六级、cet-6）', () => {
    const meta = (id: string) => catalog.books.find((b) => b.id === id)!;
    expect(meta('cet6').keywords).toEqual(expect.arrayContaining(['cet6', 'cet-6', '六级']));
    expect(meta('cet6-new').keywords).toEqual(expect.arrayContaining(['六级', '新增']));
    for (const b of catalog.books) {
      expect(b.keywords?.length, b.id).toBeGreaterThan(0);
      expect(b.keywords!.some((k) => /[一-鿿]/.test(k)), `${b.id} 缺中文别名`).toBe(true);
      expect(b.keywords!.some((k) => /[a-z]/.test(k)), `${b.id} 缺英文别名`).toBe(true);
    }
    // 计算机词表来自科研论文语料，不以“编程/程序员”误导
    expect(meta('cs-all').keywords).not.toEqual(expect.arrayContaining(['编程']));
    expect(meta('cs-all').keywords).not.toEqual(expect.arrayContaining(['程序员']));
  });
});

describe('外部词表新书（core / domain）', () => {
  /**
   * id -> [分类, 词数下限, 词数上限, 许可, 抽样必含词]。
   * 词数区间收紧到当前产物 ±10 左右：清洗规则变化导致大幅掉词时必须在这里显式改数（明细见 external-books-audit.tsv）
   */
  const BOOKS: Record<string, [string, number, number, string, string[]]> = {
    ngsl: ['core', 2852, 2861, 'CC BY-SA 4.0', ['the', 'government', 'monday', 'january', 'hundred', 'environment', 'criterion']],
    'ngsl-spoken': ['core', 715, 721, 'CC BY-SA 4.0', ['yeah', 'okay', 'pretty', 'stuff']],
    nawl: ['domain', 935, 950, 'CC BY-SA 4.0', ['empirical', 'correlation', 'parameter', 'methodology', 'criterion', 'bacterium']],
    bsl: ['domain', 1710, 1725, 'CC BY-SA 4.0', ['invoice', 'merger', 'dividend', 'audit', 'subsidiary', 'collateral', 'liquidation', 'payoff', 'salesperson', 'unauthorized', 'analytic', 'analytical']],
    tsl: ['domain', 1232, 1248, 'CC BY-SA 4.0', ['reimbursement', 'itinerary', 'resume', 'refund', 'warranty', 'payroll', 'spreadsheet', 'toner', 'outdated']],
    moel: ['domain', 495, 505, 'CC BY-SA 4.0', ['abdomen', 'antibiotic', 'antibody', 'diabetes', 'chemotherapy', 'colonoscopy', 'immunisation', 'atrium', 'bacterium',
      'bleed', 'choke', 'tingle', 'stammer', 'thump', 'bloat', 'shiver', 'chill', 'mump', 'measles', 'infected', 'rubella', 'tonsillitis', 'hives', 'shingles']],
    // 追加词典条目的专业词（runtime、tuple、recursion、parser、lessee、rubella）也在抽样里：回归“只收原词典词”导致的掉词
    'cs-250': ['domain', 210, 225, 'CC BY 4.0', ['algorithm', 'database', 'server', 'query', 'kernel', 'node', 'slice', 'runtime', 'tuple', 'recursion']],
    'cs-500': ['domain', 385, 400, 'CC BY 4.0', ['algorithm', 'compiler', 'encryption', 'asynchronous', 'cache', 'pipeline', 'orthogonal', 'parser', 'bitmap']],
    'cs-all': ['domain', 580, 592, 'CC BY 4.0', ['algorithm', 'compiler', 'router', 'debug', 'deploy', 'hash', 'log', 'encode', 'order', 'cluster', 'sense', 'message', 'timestamp', 'workflow']],
  };
  const AUDIT = fs.readFileSync(path.resolve(__dirname, '../../scripts/data/external-books-audit.tsv'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#')).slice(1).map((l) => l.split('\t') as [string, string, string, string]);
  /** 原内置词典没有、构建时从 ECDICT 追加词条的词（审计去向 added） */
  const ADDED = new Set(AUDIT.filter((r) => r[3] === 'added').map((r) => r[2]));
  const isAdded = (w: string) => ADDED.has(w);

  it('目录元数据：分类、许可、来源链接、计算机三档同组（group=cs，非 ladder）', () => {
    for (const [id, [category, min, max, license]] of Object.entries(BOOKS)) {
      const b = catalog.books.find((x) => x.id === id);
      expect(b, id).toBeDefined();
      expect(b!.category, id).toBe(category);
      expect(b!.license, id).toBe(license);
      expect(b!.url, id).toMatch(/^https:\/\//);
      expect(b!.ladder, id).toBeUndefined();
      expect(b!.size, id).toBeGreaterThanOrEqual(min);
      expect(b!.size, id).toBeLessThanOrEqual(max);
      expect(Boolean(b!.group), id).toBe(id.startsWith('cs-'));
    }
    // 显示名不用 TOEIC 商标
    const tsl = catalog.books.find((x) => x.id === 'tsl')!;
    expect(`${tsl.name} ${tsl.nameEn} ${tsl.short}`).not.toMatch(/toeic|托业/i);
    // 分类顺序：难度 → 考试 → 词频 → 通用核心词 → 专业领域
    const order = catalog.books.map((b) => b.category).filter((c, i, a) => a.indexOf(c) === i);
    expect(order).toEqual(['level', 'exam', 'frequency', 'core', 'domain']);
  });

  it('抽样词命中（含领域核心词）；无短语/大写/重音/词缀碎片', () => {
    const FRAGMENTS = ['non', 'anti', 'pre', 'sub', 'multi', 'semi', 'quasi', 'neo', 'mid', 'mini', 'micro', 'macro', 'super', 'inter', 'ex', 'trans', 'capita', 'annum', 'mister', 'amino', 'alpha', 'beta'];
    for (const [id, [, , , , sample]] of Object.entries(BOOKS)) {
      const words = bookWords(id);
      expect(sample.filter((w) => !words.has(w)), id).toEqual([]);
      expect(FRAGMENTS.filter((w) => words.has(w)), id).toEqual([]);
      expect([...words].filter((w) => !/^[a-z]+$/.test(w)), id).toEqual([]);
    }
    // NAWL 的错误词头 founds、MOEL 复数 antibodies/immunisations、TWLRACS 的 vertices 都不应原样出现
    expect(bookWords('nawl').has('founds')).toBe(false);
    for (const w of ['antibodies', 'immunisations', 'atria', 'bacteria']) expect(bookWords('moel').has(w), w).toBe(false);
    expect(bookWords('cs-all').has('vertices')).toBe(false);
    // TWLRACS 排版断词残片、专名冠名词与缩写已清洗
    for (const w of ['rithm', 'gorithm', 'tively', 'google', 'linux', 'http', 'gpu', 'bayesian', 'laplacian', 'lagrangian']) expect(bookWords('cs-all').has(w), w).toBe(false);
  });

  it('构建不自动词元化：独立词头不被换成无关的另一个词（rebound≠rebind、hives≠hive、shingles≠shingle）', () => {
    // 回归：构建曾对外部表做 ECDICT 词元化，rebound→rebind（重捆）、shingles→shingle（墙面板）、hives→hive（蜂房）。
    // 现在只有清洗表第 2 列与 EXTERNAL_HEADWORD_FIXES 的人工映射；这些词头原内置词典没有，按原词头从 ECDICT 追加词条（added）
    const WRONG: Record<string, string[]> = { bsl: ['rebind', 'outgo'], moel: ['shingle', 'hive'], 'cs-all': ['outgo'] };
    for (const [id, words] of Object.entries(WRONG)) expect(words.filter((w) => bookWords(id).has(w)), id).toEqual([]);
    const fateOf = (id: string, raw: string) => AUDIT.find((r) => r[0] === id && r[1] === raw);
    expect(fateOf('bsl', 'rebound')?.slice(2)).toEqual(['rebound', 'added']);
    expect(fateOf('moel', 'hives')?.slice(2)).toEqual(['hives', 'added']);
    expect(fateOf('moel', 'shingles')?.slice(2)).toEqual(['shingles', 'added']);
    // 追加词条的行内短释义带上本领域义（short-overrides.tsv 覆盖），原形义在前：旧词书高亮页面上的 hives/shingles 时也查这个词形
    expect(dictEntry('hives')?.s).toBe('蜂房/荨麻疹');
    expect(dictEntry('shingles')?.s).toBe('墙面板/疱疹');
    // 独立词头不换成词典里的相近词（outdated≠outdate“使过时”），按原词头追加词条
    expect(fateOf('tsl', 'outdated')?.slice(2)).toEqual(['outdated', 'added']);
    expect(fateOf('bsl', 'analytical')?.slice(2)).toEqual(['analytical', 'added']);
    expect(bookWords('tsl').has('outdate')).toBe(false);
  });

  it('追加词不改变旧词书用户的行内释义：追加词是已有词条的屈折形式时，短释义包含原形的短释义', () => {
    // 行内释义先查页面词形（engine.ts#translationKeys）：旧书收了 hive，页面上的 hives 会先命中追加词条 hives。
    // 回归：hives 曾追加为“荨麻疹”、shingles 为“带状疱疹”，只开 gk/gre 等旧书的用户看到 bee hives=荨麻疹、roof shingles=带状疱疹。
    // 屈折关系取已有词条的 ECDICT exchange（dict/full 的 x 字段）；下面是逐个审过、改换释义属于纠正的例外（与 build-data.mjs 的 ADDED_FORM_GLOSS_REVIEWED 一致）
    const REVIEWED: Record<string, string> = {
      outdated: '过时的，outdate=使过时', outgoing: '向外的，outgo=支出', rebound: '反弹，rebind=重捆',
      macroeconomics: '学科名', orthodontics: '学科名', orthopedics: '学科名',
    };
    const pairs: string[] = [];
    const problems: string[] = [];
    for (const c of 'abcdefghijklmnopqrstuvwxyz') {
      for (const [base, full] of Object.entries(readJson<Record<string, { x?: string }>>(`dict/full/${c}.json`))) {
        if (isAdded(base) || !full.x) continue;
        for (const [, form] of full.x.split('/').map((p) => p.split(':'))) {
          if (!form || form === base || !isAdded(form)) continue;
          pairs.push(form);
          const baseShort = dictEntry(base)!.s!;
          if (!REVIEWED[form] && !dictEntry(form)?.s?.includes(baseShort)) problems.push(`${form}=${dictEntry(form)?.s}（${base}=${baseShort}）`);
        }
      }
    }
    expect(problems).toEqual([]);
    // 例外表里的词确实是这种关系（表不过期），hives/shingles 走包含原形释义的规则而不是例外
    for (const w of [...Object.keys(REVIEWED), 'hives', 'shingles']) expect(pairs, w).toContain(w);
  });

  it('屈折形式词元化规则一致：词典里有原形的 -s/-ing/-ed 词条不因词形不在词典而被丢掉', () => {
    // 回归：MOEL 的 bleeding/choking、TWLRACS 的 logging/encoding/slicing 曾保留原形，因不在词典被记 nodict，
    // 而词典里明明有 bleed、log、encode、slice。规则（见 moel.tsv/twlracs.tsv 文件头）：原词形不是词典词条时还原为原形，
    // 只有原形是无关的另一个词时例外。下面白名单逐个说明为什么不还原
    const NOT_INFLECTION: Record<string, string> = {
      hives: '荨麻疹，hive=蜂房', shingles: '带状疱疹，shingle=墙面板',
      orthodontics: '学科名，非复数', orthopedics: '学科名，非复数', macroeconomics: '学科名，非复数', outgoing: 'out+going 合成词，非 outgo 的屈折',
      outdated: '-ed 形容词（过时的），outdate=使过时',
    };
    const bases = (w: string) => [
      w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/ies$/, 'y'), w.replace(/ing$/, ''), w.replace(/ing$/, 'e'),
      w.replace(/ed$/, ''), w.replace(/ed$/, 'e'), w.replace(/d$/, ''), w.replace(/(.)\1ing$/, '$1'), w.replace(/(.)\1ed$/, '$1'),
    ].filter((b) => b !== w && dictEntry(b));
    // added 的词按原词形追加了词条，同样要求：词典里已有原形的屈折形式应在清洗表里还原，不应另追加一个词形词条
    const dropped = AUDIT.filter((r) => (r[3] === 'nodict' || r[3] === 'added') && !NOT_INFLECTION[r[2]] && bases(r[2]).some((b) => !isAdded(b))).map((r) => `${r[0]}:${r[2]}→${bases(r[2]).join('/')}`);
    expect(dropped).toEqual([]);
    // 原词形本身是词典词条（自有释义）的保留原形，不被还原：infected（被感染的）
    expect(bookWords('moel').has('infected')).toBe(true);
    // BSL 的噪声词按复核结论去掉
    for (const w of ['pizza', 'corn']) expect(bookWords('bsl').has(w), w).toBe(false);
  });

  it('twlracs.tsv 覆盖论文附录全部 769 个位次：每个位次一行，不收的行写明原因', () => {
    const rows = fs.readFileSync(path.resolve(__dirname, '../../scripts/data/twlracs.tsv'), 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    expect(rows.map((r) => Number(r[0]))).toEqual(Array.from({ length: 769 }, (_, i) => i + 1));
    for (const r of rows) {
      expect(r[1], r.join(' ')).toMatch(/^([a-z]+|-)$/);
      expect(r[2], r.join(' ')).toMatch(/^[a-z]+$/);
      // 不收的行（-）必须写原因：断词残片 / 缩写 / 专名/冠名词；收的行不应带原因列
      if (r[1] === '-') expect(['断词残片', '缩写', '专名/冠名词'], r.join(' ')).toContain(r[3]);
      else expect(r[3], r.join(' ')).toBeUndefined();
    }
    // 第 245、307 位 SLICE/SLICES 曾漏收：现在与第 126 位 slicing 同为 slice，cs-250 收录
    expect(rows.filter((r) => ['126', '245', '307'].includes(r[0]!)).map((r) => r[1])).toEqual(['slice', 'slice', 'slice']);
  });

  it('NOTICE 的修改说明与产物一致：举例的映射结果都在词书里，说“不收”的词都不在', () => {
    const notice = fs.readFileSync(path.join(DATA, 'NOTICE.txt'), 'utf8');
    // 按来源分节（以“- ”开头的行），每节里的 “a → b” 映射：b 必须在该节对应的词书里
    const SECTIONS: [RegExp, string[]][] = [
      [/^- Business Service List/, ['bsl']],
      // TSL 一节没有词头映射（outdated 不再换成 outdate，按原词头追加词条），不在此列
      [/^- Medical Oral English List/, ['moel']],
      [/^- A Technical Word List/, ['cs-all']],
    ];
    const blocks = notice.split(/\n(?=- )/);
    for (const [head, ids] of SECTIONS) {
      const block = blocks.find((b) => head.test(b));
      expect(block, String(head)).toBeDefined();
      // 左侧写成 a/b/c 的无歧义形式：嵌套量词 (?:\/?[a-z]+)+ 在长英文段上会灾难性回溯（单条用例 4s+，并发时超时）
      const targets = [...block!.matchAll(/[a-z]+(?:\/[a-z]+)* (?:→|换成) ([a-z]+)/g)].map((m) => m[1]!);
      expect(targets.length, String(head)).toBeGreaterThan(0);
      for (const id of ids) expect(targets.filter((w) => !bookWords(id).has(w)), `${id}: ${String(head)}`).toEqual([]);
    }
    // 共同修改段里的映射：结果词在任一新书里
    const all = new Set(Object.keys(BOOKS).flatMap((id) => [...bookWords(id)]));
    const common = blocks.find((b) => b.includes('共同的修改'))!;
    const commonTargets = [...common.matchAll(/[a-z]+ → ([a-z]+)/g)].map((m) => m[1]!);
    expect(commonTargets.filter((w) => !all.has(w))).toEqual([]);
    // 共同修改段举例的追加词（原内置词典没有、从 ECDICT 追加）确实收进了新书
    for (const w of ['runtime', 'tuple', 'rubella']) {
      expect(common).toContain(w);
      expect(all.has(w), w).toBe(true);
    }
  });

  it('词书忠实于原表：不额外去 A1–A2 基础词（作熟词本时就是原表集合，基础词由 cefr-a2 等熟词本处理）', () => {
    for (const w of ['apple', 'birthday']) expect(bookWords('tsl').has(w), w).toBe(true);
    // TWLRACS 位次第 1 的 type 在三档里都有
    for (const id of ['cs-250', 'cs-500', 'cs-all']) expect(bookWords(id).has('type'), id).toBe(true);
    for (const b of catalog.books.filter((x) => x.category === 'core' || x.category === 'domain')) {
      expect(b.description, b.id).not.toMatch(/基础词/);
    }
  });

  it('计算机三档说明里的数字与审计表对得上：附录词条数 → 收录数', () => {
    for (const id of ['cs-250', 'cs-500', 'cs-all']) {
      const b = catalog.books.find((x) => x.id === id)!;
      const rows = AUDIT.filter((r) => r[0] === id);
      const m = (b.description ?? '').match(/附录(?:位次前 \d+ 的|全部) (\d+) 个词条，收录 (\d+) 个/);
      expect(m, id).not.toBeNull();
      expect(Number(m![1]), id).toBe(rows.length);
      expect(Number(m![2]), id).toBe(b.size);
      expect(rows.filter((r) => r[3] === 'ok' || r[3] === 'added').length, id).toBe(b.size);
    }
  });

  it('审计表与产物一致：每个原始词条都有去向，收录的词恰好是词书词，nodict 的词确实不在词典里，追加词有词条', () => {
    const FATES = new Set(['ok', 'added', 'dup', 'excluded', 'form', 'affix', 'noise', 'inflection', 'nodict']);
    for (const id of Object.keys(BOOKS)) {
      const rows = AUDIT.filter((r) => r[0] === id);
      expect(rows.length, id).toBeGreaterThan(0);
      expect(rows.filter((r) => !FATES.has(r[3])), id).toEqual([]);
      const kept = new Set(rows.filter((r) => r[3] === 'ok' || r[3] === 'added').map((r) => r[2]));
      expect(kept, id).toEqual(bookWords(id));
      expect(rows.filter((r) => r[3] === 'nodict' && dictEntry(r[2])), id).toEqual([]);
      expect(rows.filter((r) => r[3] === 'added' && !dictEntry(r[2])), id).toEqual([]);
    }
    // 追加词判定按词、与书无关：同一个词在各书审计行里的去向一致（不会一本 ok、一本 added）
    const fatesOf = new Map<string, Set<string>>();
    for (const r of AUDIT.filter((x) => x[3] === 'ok' || x[3] === 'added')) fatesOf.set(r[2], (fatesOf.get(r[2]) ?? new Set()).add(r[3]));
    expect([...fatesOf].filter(([, f]) => f.size > 1).map(([w]) => w)).toEqual([]);
    // nodict 基本消失：只剩 ECDICT 没有中文释义的词（polynomially 只有 [网络] 释义）
    expect([...new Set(AUDIT.filter((r) => r[3] === 'nodict').map((r) => r[2]))].sort()).toEqual(['polynomially']);
    // 清洗表给的原形没有中文释义时退回原词形：precomputed 的原形 precompute 只有 [网络] 释义，precomputed 本身有“[计] 预先计算的”
    expect(AUDIT.filter((r) => r[1] === 'precomputed').map((r) => `${r[0]}:${r[2]}:${r[3]}`)).toEqual(['cs-500:precomputed:added', 'cs-all:precomputed:added']);
    // cs-250 的原始条目 = TWLRACS 清洗表中位次 ≤ 250 的全部词元
    const tsv = fs.readFileSync(path.resolve(__dirname, '../../scripts/data/twlracs.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    expect(AUDIT.filter((r) => r[0] === 'cs-250').length).toBe(tsv.filter((l) => Number(l.split('\t')[0]) <= 250).length);
  });

  it('计算机三档是嵌套的“前 N”集合：cs-250 ⊂ cs-500 ⊂ cs-all', () => {
    const [a, b, c] = ['cs-250', 'cs-500', 'cs-all'].map(bookWords);
    expect([...a!].filter((w) => !b!.has(w))).toEqual([]);
    expect([...b!].filter((w) => !c!.has(w))).toEqual([]);
    expect(a!.size).toBeLessThan(b!.size);
    expect(b!.size).toBeLessThan(c!.size);
  });

  it('每个新书词都有词典条目与行内短释义', () => {
    const missing: string[] = [];
    const noShort: string[] = [];
    for (const id of Object.keys(BOOKS)) {
      for (const w of bookWords(id)) {
        const e = dictEntry(w);
        if (!e) missing.push(`${id}:${w}`);
        else if (!e.s) noShort.push(`${id}:${w}`);
      }
    }
    expect(missing).toEqual([]);
    expect(noShort).toEqual([]);
  });
});

describe('已有数据产物不变（新增词书不得改动旧词书与已有词典词条）', () => {
  /**
   * 基线 tests/fixtures/data-baseline.json：新增外部词表书之前 public/data 下产物的 sha256（index.json、NOTICE.txt 除外）。
   * - exact：lemma 与旧词书，必须逐字节不变
   * - appendOnly：dict 短/全表分片，只允许追加外部词表书的新词条（审计去向 added）——新分片去掉追加词后重新 JSON.stringify，
   *   必须与基线文件逐字节一致（分片是按词排序的 JSON.stringify 输出，去掉追加词即还原旧文件），即旧词条的所有字段都不变
   * 改 build-data.mjs、short-overrides.tsv 等若连带改了旧短释义，这里会报。构建时也可用 --keep-dict <旧 data 目录> 做同样校验。
   * 确需改动已有词典/词书时（如修正释义），在同一次提交里重新生成基线（dict 分片要先去掉追加词再算哈希）并在提交说明中写明原因
   */
  const BASELINE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/data-baseline.json'), 'utf8')) as {
    exact: Record<string, string>;
    appendOnly: Record<string, string>;
  };
  const sha256 = (buf: string | Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
  const ADDED = new Set(fs.readFileSync(path.resolve(__dirname, '../../scripts/data/external-books-audit.tsv'), 'utf8')
    .split('\n').map((l) => l.split('\t')).filter((r) => r[3] === 'added').map((r) => r[2]!));
  /** 分片去掉追加词后的 JSON 文本（还原新增词书之前的分片） */
  const withoutAdded = (rel: string) => {
    const shard = JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.entries(shard).filter(([w]) => !ADDED.has(w))));
  };

  it('lemma 与旧词书逐字节等于基线', () => {
    expect(Object.keys(BASELINE.exact).length).toBe(28);
    const changed = Object.entries(BASELINE.exact).filter(([rel, hash]) => sha256(fs.readFileSync(path.join(DATA, rel))) !== hash).map(([rel]) => rel);
    expect(changed).toEqual([]);
  });

  it('dict 分片只追加：去掉追加词后与基线逐字节一致（旧词条所有字段不变）', () => {
    expect(Object.keys(BASELINE.appendOnly).length).toBe(52);
    const changed = Object.entries(BASELINE.appendOnly).filter(([rel, hash]) => sha256(withoutAdded(rel)) !== hash).map(([rel]) => rel);
    expect(changed).toEqual([]);
  });

  it('追加词条确实是新增的：每个追加词都有短表词条，且确实不在基线分片里（新分片 ≠ 去掉追加词的分片）', () => {
    expect(ADDED.size).toBeGreaterThan(100);
    for (const w of ADDED) expect(dictEntry(w), w).toBeDefined();
    // 有追加词的短表分片，文件本身必然与基线不同（追加词若本就在旧分片里，去掉它后哈希会对不上，上一条用例报）
    for (const letter of new Set([...ADDED].map((w) => w[0]))) {
      const rel = `dict/${letter}.json`;
      expect(sha256(fs.readFileSync(path.join(DATA, rel))), rel).not.toBe(BASELINE.appendOnly[rel]);
    }
  });

  it('dict 目录没有基线之外的分片', () => {
    const shards = ['dict', 'dict/full'].flatMap((d) => fs.readdirSync(path.join(DATA, d)).filter((f) => f.endsWith('.json')).map((f) => `${d}/${f}`));
    expect(shards.filter((rel) => !(rel in BASELINE.appendOnly))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 标杆回归：同一篇文章上的生词判定（对照 Relingo B2 级别在 tests/fixtures/article.html 上标出的词）
// ---------------------------------------------------------------------------

describe('文章生词判定回归（article.html）', () => {
  // 用词典全表的词形（x）反查原形，作为与 lemma 分片解耦的最小还原
  const formToLemma = new Map<string, string>();
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const full = readJson<DictShardFile>(`dict/full/${c}.json`);
    for (const [w, e] of Object.entries(full)) for (const f of parseForms(e.x) ?? []) if (!formToLemma.has(f.word)) formToLemma.set(f.word, w);
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures/article.html'), 'utf8');
  const text = html.replace(/<(script|style|pre)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((m) => m[0].toLowerCase());
  const hits = (id: string) => {
    const words = bookWords(id);
    const out = new Set<string>();
    for (const t of tokens) {
      const l = words.has(t) ? t : formToLemma.get(t);
      if (l && words.has(l)) out.add(l);
    }
    return out;
  };
  // Relingo（B2）在该页标出的词中，我们的数据应当覆盖的部分（屈折/派生由 lemma 分片处理，这里只列原形出现在页面的）
  const RELINGO_B2 = ['surge', 'assumption', 'pessimistic', 'inspect', 'barrier', 'dilemma', 'vicious', 'retreat', 'revenue', 'ethical', 'reluctant', 'infrastructure', 'premise', 'vulnerable', 'hybrid', 'conventional', 'mature', 'quantify', 'genuine', 'skeptical', 'distinctive', 'urban', 'deliberate'];
  const COMMON = ['city', 'water', 'storm', 'year', 'people', 'family', 'price', 'money', 'home', 'children', 'trust', 'question'];

  it('cefr-b2：覆盖 Relingo B2 判定，常用词不高亮', () => {
    const h = hits('cefr-b2');
    const recall = RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length;
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
  });

  it('cet6（默认词书）：高亮量与 Relingo 同量级，常用词不高亮', () => {
    const h = hits('cet6');
    expect(RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length).toBeGreaterThanOrEqual(0.75);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
    // Relingo 在此页标出约 75 个不同原形；默认词书不应过密（< 2 倍）
    expect(h.size).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// 行内短释义质量（第二阶段）：常用义项、词性一致、2–6 字
// ---------------------------------------------------------------------------

describe('行内短释义质量', () => {
  /**
   * 金标：常见多义词的可接受短释义（任一即可，比较时忽略形容词“的”/副词“地”/动词“使”）。
   * 依据有道词典网页首义项与 Relingo 在同一文章上的行内注解；只收“常用义 vs 冷僻义/专业义”区分明显的词。
   */
  const GOLD: Record<string, string[]> = {
    abandon: ['放弃'], accept: ['接受'], address: ['地址', '处理', '演讲'], apply: ['申请', '应用'], believe: ['相信'],
    explain: ['解释', '说明'], famous: ['著名的'], concrete: ['具体的'], minute: ['分钟'], present: ['现在的', '现在', '礼物', '呈现', '提出', '出席的'],
    premium: ['高级的', '优质的', '溢价', '保险费'], implement: ['实施', '执行'], multiple: ['多个', '多重的', '多样的', '许多的'],
    project: ['项目', '工程', '计划'], current: ['当前的', '现在的'], apartment: ['公寓'], area: ['区域', '地区', '面积'],
    loss: ['损失', '亏损'], observe: ['观察', '遵守'], deploy: ['部署'], merge: ['合并'], fix: ['修理', '固定', '修复'],
    scenario: ['情景', '场景', '方案', '设想'], convert: ['转换', '转变'], obsolete: ['过时的', '废弃的'], socket: ['插座', '插口'],
    serum: ['血清'], basin: ['盆地'], arbitration: ['仲裁'], impeachment: ['弹劾'], credential: ['证书', '凭据'],
    abstraction: ['抽象'], phase: ['阶段'], coup: ['政变'], boost: ['提高', '促进', '增加'], drain: ['排水', '耗尽', '消耗'],
    recruit: ['招募', '招聘', '新兵'], patch: ['补丁', '修补', '小块'], judicial: ['司法的'], odd: ['奇怪的'], integrate: ['整合', '使结合', '融入'],
    sustainable: ['可持续的'], removal: ['移除', '去除', '清除'], surge: ['激增', '汹涌', '浪涌'], assumption: ['假设', '假定'],
    barrier: ['障碍', '屏障', '障碍物'], revenue: ['收入', '税收'], infrastructure: ['基础设施'], vulnerable: ['脆弱的', '易受攻击的', '易受伤害的'],
    hybrid: ['混合的', '杂交', '混合物'], conventional: ['传统的', '常规的'], genuine: ['真正的'], dilemma: ['困境'], retreat: ['撤退'],
    ethical: ['伦理的', '道德的'], reluctant: ['不情愿的'], premise: ['前提'], pessimistic: ['悲观的'], inspect: ['检查'],
    quantify: ['量化'], mature: ['成熟的'], urban: ['城市的'], federal: ['联邦的'], medicine: ['药', '医学', '药物'],
    parent: ['父母', '家长', '父亲'], iodine: ['碘'], immunity: ['免疫力', '免疫'], screwdriver: ['螺丝刀'], adapter: ['适配器'],
    filter: ['过滤器', '过滤'], input: ['输入'], output: ['输出', '产量'], default: ['默认', '违约'], interface: ['界面', '接口'],
    release: ['发布', '释放'], file: ['文件', '档案'], user: ['用户'], domestic: ['国内的', '家庭的'], primary: ['主要的', '首要的'],
    technical: ['技术的'], chip: ['芯片', '碎片'], peer: ['同龄人', '同事', '同伴'], integration: ['整合', '一体化', '结合'],
    programming: ['编程', '程序设计'], array: ['一系列', '数组', '大量'], anxious: ['焦虑的', '担心的', '渴望的'],
  };
  const norm = (s: string) => s.replace(/^使(?=..)/, '').replace(/(?<=..)[的地]$/, '');

  it('常见多义词取常用义项（金标命中率 ≥ 95%）', () => {
    const miss: string[] = [];
    for (const [w, ok] of Object.entries(GOLD)) {
      const s = dictEntry(w)?.s ?? '';
      if (!ok.some((g) => norm(g) === norm(s))) miss.push(`${w}=${s}`);
    }
    expect(miss.length / Object.keys(GOLD).length, miss.join(' ')).toBeLessThanOrEqual(0.05);
  });

  it('常见网页/科技词与数量词：硬性回归（不允许任何一个回退）', () => {
    // 第 2 轮需求核对与盲评中出现的错误义项（括注为曾经的错误值）
    const MUST: Record<string, string> = {
      subscribe: '订阅', subscription: '订阅', quote: '引用', hover: '盘旋', token: '令牌', console: '控制台', crew: '工作人员',
      faculty: '教职员工', browser: '浏览器', server: '服务器', cache: '缓存', tutorial: '教程', printer: '打印机', widget: '小部件',
      dew: '露水', tabulate: '制成表格', email: '电子邮件', online: '在线的', sidebar: '侧边栏', avatar: '头像', module: '模块',
      // 数量词：million 不是“万”，billion 不是“亿”
      thousand: '千', million: '百万', billion: '十亿', trillion: '万亿',
      // 领域误义：utilities 不是“实用程序”，projections 不是“投影”
      utility: '公用事业', projection: '预测', stack: '堆', spectrum: '光谱', persist: '持续', soar: '飙升', bulk: '大部分',
      // data 集成审计第 1 轮：现代常用义（submit 曾为“服从”、legacy“遗赠”、attribute“归于”、render“使变得”），
      // 以及行内括注实测的非常用义（volatile 挥发性的、linger 消磨、prone 俯卧的、resilient 弹回的、densely 浓密地）
      submit: '提交', legacy: '遗产', attribute: '属性', render: '呈现', volatile: '易变的', linger: '逗留', prone: '易于',
      resilient: '有韧性的', dense: '密集的', densely: '密集地',
      reassurance: '安慰', scarce: '稀缺的', grid: '网格', planner: '规划者', valuation: '估值', incremental: '渐进的', snippet: '片段',
      eventual: '最终的',
    };
    const wrong = Object.entries(MUST).filter(([w, s]) => dictEntry(w)?.s !== s).map(([w]) => `${w}=${dictEntry(w)?.s}`);
    expect(wrong).toEqual([]);
  });

  it('动词短释义 v 精炼完整：≤ 6 字且不含“…”', () => {
    const bad: string[] = [];
    for (const c of 'abcdefghijklmnopqrstuvwxyz') for (const [w, e] of Object.entries(shortShard(c))) if (e.v && (e.v.length > 6 || e.v.includes('…'))) bad.push(`${w}=${e.v}`);
    expect(bad).toEqual([]);
  });

  it('构建脚本的 v 检查：≤ 6 字与“…”残缺检查生效，人工覆盖表全部合格', () => {
    expect(isCleanVerbShort('匹配')).toBe(true);
    expect(isCleanVerbShort('使相形见绌')).toBe(true);
    // 超长、残缺框式（ECDICT 的“在上盖…的邮戳”“确定…年代”）、ASCII 省略号都不合格
    for (const v of ['阻碍议案的通过', '在上盖…的邮戳', '确定…年代', '使...加快', '']) expect(isCleanVerbShort(v), v).toBe(false);
    // 不合格的覆盖行解析即抛错（build-data.mjs 构建失败）；'-' 解析为空串表示置空
    expect(() => parseVerbOverrides('ware\t留心于…之上\n')).toThrow();
    expect(() => parseVerbOverrides('ware\n')).toThrow();
    expect(parseVerbOverrides('# 注释\nware\t-\nmatch\t匹配\n')).toEqual(new Map([['ware', ''], ['match', '匹配']]));
    const overrides = parseVerbOverrides(fs.readFileSync(path.resolve(__dirname, '../../scripts/data/verb-overrides.tsv'), 'utf8'));
    expect(overrides.size).toBeGreaterThan(100);
  });

  it('D1 回归：s 取常用义、不超长；v 不取冷僻义（改常用义或置空）', () => {
    // 曾经的错误值见括注：olympic 奥林匹斯山的、advertise 通知、impress 盖印、account 解释、calculus 结石、stewardess 女管家、
    // commend 推荐、teenager 十几岁的青少年、olympics 奥林匹克运动会、babysitter 临时照顾幼儿者
    const S: Record<string, string> = {
      olympic: '奥运的', advertise: '做广告', impress: '给人印象', account: '账户', calculus: '微积分', stewardess: '空姐',
      commend: '表扬', teenager: '青少年', olympics: '奥运会', babysitter: '保姆',
    };
    expect(Object.entries(S).filter(([w, s]) => dictEntry(w)?.s !== s).map(([w]) => `${w}=${dictEntry(w)?.s}`)).toEqual([]);
    // v：使比赛、卷发、筛选、过时、减轻、挖苦、逆向移动、留心 → 常用义；undefined 表示置空（行内回退到 s）
    const V: Record<string, string | undefined> = {
      match: '匹配', wave: '挥手', bolt: '闩上', date: '约会', plaster: '涂抹', quiz: undefined, counter: '反击', ware: undefined,
      fire: '开火', account: undefined,
    };
    expect(Object.entries(V).filter(([w, v]) => dictEntry(w)?.v !== v).map(([w]) => `${w}=${dictEntry(w)?.v}`)).toEqual([]);
  });

  it('词书词的短释义 ≥ 95% 为 2–6 字，且不含英文、括注与残留标点', () => {
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    let ok = 0;
    let total = 0;
    const dirty: string[] = [];
    for (const w of all) {
      const s = dictEntry(w)?.s;
      if (!s) continue;
      total++;
      if (s.length >= 2 && s.length <= 6) ok++;
      // 允许 DNA/OK 这类大写缩写，不允许小写英文、括号、分隔符与 & 残留
      if (/[a-z<>[\]()（）〔〕【】&，、；]/.test(s)) dirty.push(`${w}=${s}`);
    }
    expect(ok / total).toBeGreaterThanOrEqual(0.95);
    expect(dirty).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 误匹配：人名/地名/缩写/连字符前缀不进词书；用户词书中的短语与连字符词不造成误匹配
// ---------------------------------------------------------------------------

describe('误匹配防护', () => {
  it('内置词书不含人名地名同形词、缩写、罗马数字与连字符前缀', () => {
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    const NOT = [
      'chelsea', 'oliver', 'marx', 'hong', 'kong', 'russell', 'newton', 'jordan', 'lee', 'tony', 'taylor', 'glasgow',
      'vs', 'etc', 'km', 'ft', 'ph', 'iii', 'xiv', 're', 'non', 'mid', 'micro', 'macro', 'mini', 'bio', 'alpha', 'beta',
    ];
    expect(NOT.filter((w) => all.has(w))).toEqual([]);
    // 英式拼写不受“只有 BNC 排名”规则误伤
    for (const w of ['emphasise', 'privatisation']) expect(all.has(w), w).toBe(true);
  });

  it('用户词书里的短语/连字符词：分词按连字符切开，只会漏标、不会把组成部分误标', async () => {
    const { tokenize } = await import('@/core/text/tokenize');
    const { WordMatcher } = await import('@/core/match/matcher');
    const meta = localBookMeta({ id: 'local:p', name: 'p', format: 'txt', wordCount: 3, createdAt: 0, updatedAt: 0 });
    const book = createUserWordBook(meta, { 'well-known': { word: 'well-known' }, 'give up': { word: 'give up' }, 'e-mail': { word: 'e-mail' } });
    const lemmatizer = { candidates: (s: string) => [s.toLowerCase()] };
    const m = new WordMatcher({ lemmatizer, books: [book], known: new Set() });
    const hits = tokenize('A well-known author will never give up; send an e-mail.').filter((t) => m.match(t.word));
    expect(hits).toEqual([]);
  });

  it('isHyphenPrefix：auto/vice/micro 等构词前缀', async () => {
    const { isHyphenPrefix } = await import('@/core/dict/hyphen');
    for (const w of ['auto', 'Vice', 'micro', 'self', 'non']) expect(isHyphenPrefix(w), w).toBe(true);
    for (const w of ['vulnerable', 'premise']) expect(isHyphenPrefix(w), w).toBe(false);
  });
});

describe('编程熟词（v8 代码块）', () => {
  it('收录常见关键字与缩写，大小写不敏感', async () => {
    const { isCodeKnownWord, CODE_KNOWN_WORDS } = await import('@/core/dict/code-words');
    for (const w of ['if', 'return', 'const', 'var', 'func', 'str', 'init', 'args', 'Ctx', 'impl', 'kwargs', 'async', 'Await', 'nullptr', 'stdout']) {
      expect(isCodeKnownWord(w), w).toBe(true);
    }
    // 正常词汇不应被当成编程熟词
    for (const w of ['vulnerable', 'element', 'infrastructure', 'premise']) expect(isCodeKnownWord(w), w).toBe(false);
    expect([...CODE_KNOWN_WORDS].every((w) => w === w.toLowerCase())).toBe(true);
  });
  it('标识符中的屈折形式按原形判断（defaults、modules、callbacks）', async () => {
    const { isCodeKnownWord } = await import('@/core/dict/code-words');
    for (const w of ['defaults', 'modules', 'imports', 'callbacks', 'Exported', 'returning', 'foo', 'tsx']) expect(isCodeKnownWord(w), w).toBe(true);
    for (const w of ['cases', 'element', 'premises']) expect(isCodeKnownWord(w), w).toBe(w === 'cases');
  });
  it('高频编程术语在代码本体中视为熟词（Object.prototype、eventListener、renderItem）', async () => {
    const { isCodeKnownWord } = await import('@/core/dict/code-words');
    const TERMS = ['prototype', 'stack', 'heap', 'queue', 'node', 'handler', 'listener', 'render', 'attribute', 'instance', 'array', 'query', 'token'];
    for (const w of [...TERMS, 'Listeners', 'handlers', 'rendered', 'rendering', 'attributes', 'nodes']) expect(isCodeKnownWord(w), w).toBe(true);
  });

});

describe('动词短释义 shortVerb（v）', () => {
  it('名词/形容词首选义项的词另给动词释义，打包产物与 unpack 一致', async () => {
    expect(dictEntry('advocate')).toMatchObject({ s: '提倡者', v: '提倡' });
    // 首选义项本身就是动词的词不重复提供
    expect(dictEntry('abandon')?.v).toBeUndefined();
    const dict = new PackagedDictionary(async (p) => (p.startsWith('full/') ? {} : shortShard(p)));
    expect((await dict.lookupMany(['advocate'])).get('advocate')).toMatchObject({ short: '提倡者', shortVerb: '提倡' });
  });

  it('CompositeDictionary：用户词书给了 short 时不混入打包词典的 shortVerb', async () => {
    const packaged = new PackagedDictionary(async (p): Promise<DictShardFile> => (p === 'a' ? { advocate: { s: '提倡者', v: '提倡' } } : {}));
    const meta = localBookMeta({ id: 'local:2', name: 't', format: 'txt', wordCount: 1, createdAt: 0, updatedAt: 0 });
    const user = new UserBooksDictionary([createUserWordBook(meta, { advocate: { word: 'advocate', trans: '拥护者' } })]);
    const many = await new CompositeDictionary([user, packaged]).lookupMany(['advocate']);
    expect(many.get('advocate')).toMatchObject({ short: '拥护者' });
    expect(many.get('advocate')?.shortVerb).toBeUndefined();
    expect((await new CompositeDictionary([packaged]).lookupMany(['advocate'])).get('advocate')?.shortVerb).toBe('提倡');
  });
});

describe('搭配义覆盖 collocationShort', () => {
  it('固定搭配改用搭配义，未命中回退', async () => {
    const { collocationShort } = await import('@/core/dict/collocation');
    expect(collocationShort('vicious', undefined, 'cycle')).toBe('恶性的');
    expect(collocationShort('concrete', 'the', 'structure')).toBe('混凝土');
    expect(collocationShort('surge', 'storm', 'flood')).toBe('风暴潮');
    expect(collocationShort('bulk', 'the', 'of')).toBe('大部分');
    expect(collocationShort('shed', 'to', 'light')).toBe('揭示');
    expect(collocationShort('vicious', 'a', 'dog')).toBeUndefined();
    expect(collocationShort('concrete')).toBeUndefined();
  });
});

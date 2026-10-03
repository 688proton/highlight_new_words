import type { BookCatalog, BookMeta } from './types';
// 构建时内联扩展包里的词书目录（public/data/books/index.json，由 scripts/data/build-data.mjs 生成，与扩展包同版本）
import catalogJson from '../../../public/data/books/index.json';

/**
 * 打包进脚本的内置词书目录（约 17KB），供内容脚本首屏使用：
 * 熟词本中的 ladder 书（如 cefr-b2 作熟词 = A1–B1）要的是补集文件（base + 更低各档），需要目录才知道是哪几个。
 * 若运行时再 fetch 目录，目录晚于设置到达时补集文件要等目录回来才发出，比生词本文件多一次串行往返；
 * 内联后读到设置即可同步算出全部文件，与生词本文件同时发出。目录随扩展包发布、运行期不变，内联与 fetch 得到的内容相同。
 * JSON 推断出的字面量类型（category 为 string 等）与 BookCatalog 不兼容，需要断言。
 */
export const PACKAGED_CATALOG = catalogJson as unknown as BookCatalog;

let builtinMetas: BookMeta[] | undefined;

/**
 * 打包目录中全部内置书的元数据（kind 为 builtin，与 registry.list() 中的内置部分相同）：
 * 选项页 toggleBook 等调用方没传元数据时，用它判断内置书的单选组（ladder/group）与跨表互斥，不必异步加载目录。
 */
export function packagedBuiltinMetas(): BookMeta[] {
  return (builtinMetas ??= PACKAGED_CATALOG.books.map((b) => ({ ...b, kind: 'builtin' as const })));
}

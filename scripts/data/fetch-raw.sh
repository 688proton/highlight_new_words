#!/usr/bin/env bash
# 下载内置词书/词典构建所需的原始数据（固定到具体 commit，保证可复现）。
# 用法：scripts/data/fetch-raw.sh [raw目录=.cache/data-raw]
#   --with-ultimate  额外下载 ECDICT-ultimate（98MB zip，只用其 pos 词性占比给短释义排序，可选）
# 之后执行：node scripts/data/build-data.mjs --raw <raw目录>
set -euo pipefail

RAW="${1:-.cache/data-raw}"
WITH_ULTIMATE=0
for a in "$@"; do [[ "$a" == "--with-ultimate" ]] && WITH_ULTIMATE=1; done
[[ "$RAW" == --* ]] && RAW=.cache/data-raw
mkdir -p "$RAW/cefrj" "$RAW/kyle" "$RAW/ngsl"

# 数据源与版本（升级时改 commit 并重新构建）
ECDICT_SHA=bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b          # skywind3000/ECDICT（MIT）
CEFRJ_SHA=d4e45b75b38f27b30dfc5c44d8c571aec7e7092f           # openlanguageprofiles/olp-en-cefrj（CEFR-J 1.5，免费商用需署名）
KYLE_SHA=c4c6c80879ff17d7025c28fb853a4991c8e6be6a            # KyleBing/english-vocabulary（BSD-3，只用词表与义项排序信号，不输出其释义）

gh_raw() { # gh_raw <owner/repo> <sha> <path> <输出文件>
  curl -fsSL --retry 3 -o "$4" "https://raw.githubusercontent.com/$1/$2/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$3")"
}

gh_raw skywind3000/ECDICT "$ECDICT_SHA" ecdict.csv "$RAW/ecdict.csv"
gh_raw skywind3000/ECDICT "$ECDICT_SHA" lemma.en.txt "$RAW/lemma.en.txt"
gh_raw openlanguageprofiles/olp-en-cefrj "$CEFRJ_SHA" cefrj-vocabulary-profile-1.5.csv "$RAW/cefrj/cefrj-vocabulary-profile-1.5.csv"
# KyleBing：SAT/专四/专八 取词表；其余词表只作短释义“常用义项”投票信号（build-data.mjs#kyleGloss 读取 kyle/ 下全部 .txt），
# 缺了这些文件构建仍能通过，但 dict 短释义会与仓库产物不一致
for f in "1 初中-乱序.txt" "2 高中-乱序.txt" "3 四级-乱序.txt" "4 六级-乱序.txt" "5 考研-乱序.txt" "6 托福-乱序.txt" "7 SAT-乱序.txt"; do
  gh_raw KyleBing/english-vocabulary "$KYLE_SHA" "$f" "$RAW/kyle/$f"
done
for f in 专四 专八 GRE GMAT 雅思 商务英语; do
  gh_raw KyleBing/english-vocabulary "$KYLE_SHA" "full_line_tsv/simple/正序/$f.txt" "$RAW/kyle/tsv_$f.txt"
done

# NGSL Project 系列词表（CC BY-SA 4.0，https://www.newgeneralservicelist.com）：/s/ 短链不带版本号，用 sha256 锁定内容，
# 官方更新后校验失败，需人工核对新版本后再改这里的校验值
ngsl() { # ngsl <文件名> <sha256>
  curl -fsSL --retry 3 -o "$RAW/ngsl/$1" "https://www.newgeneralservicelist.com/s/$1"
  echo "$2  $RAW/ngsl/$1" | sha256sum -c --quiet - || { echo "校验失败：$1 内容已变化（官方可能发布了新版本）" >&2; exit 1; }
}
ngsl NGSL_12_stats.csv 2098bab8955a120a9766c6282a51d7d578c6cb0a7d946600d2ffb73ba25a0b44                       # NGSL 1.2
ngsl SUP_lemmatized.csv 7bb4c76cbe43ae87240be4ac7ada370b9e1a0d9d631d8c4430138646965d03f6                      # NGSL 补充词（星期/月份/数字）
ngsl NGSL-Spoken_12_stats.csv 07708940c50a07cac4f507fd1e87bdd50081d7b87713a66a99beb3c8c4d11ac8                # NGSL-Spoken 1.2
ngsl NAWL_12_lemmatized_for_teaching.csv 1790b0fa22c5815ebf5a9a15c9363c03a6e906c77bf217f99033734f1459137b     # NAWL 1.2（latin1）
ngsl BSL_120_stats.csv 45055265eb4e74c65f5d26edabbc1a0da38c45bbb924cd9bd01fd391b74ff157                       # BSL 1.20
ngsl TSL_12_stats.csv 2259df25a1077b04067ef0c0e9e4c98b46c91e4d539741dfaceba88651ff486d                        # TSL 1.2（latin1）
# MOEL（xlsx）与 TWLRACS（论文 PDF 附录）需人工清洗，清洗后的词表直接提交在 scripts/data/moel.tsv、twlracs.tsv
# （文件头有来源 URL、原始 xlsx/PDF 的 sha256 与修改说明），
# 构建不依赖这里下载

if [[ $WITH_ULTIMATE == 1 ]]; then
  # Release 资产，需 gh CLI
  gh release download -R skywind3000/ECDICT-ultimate -p ecdict-ultimate-csv.zip -D "$RAW" --clobber
  # Release 资产没有 commit 可锁，用 sha256 锁定内容（仓库 dict 产物由这个版本生成，换版本会改变短释义排序）
  echo "74b6bced850b58c0dc54e992cc82d08ea7dd88cb99a8b7f4574e6cac48721548  $RAW/ecdict-ultimate-csv.zip" | sha256sum -c --quiet - \
    || { echo "校验失败：ecdict-ultimate-csv.zip 内容已变化" >&2; exit 1; }
  mkdir -p "$RAW/ultimate" && unzip -o -q "$RAW/ecdict-ultimate-csv.zip" -d "$RAW/ultimate"
fi
echo "raw data ready in $RAW"

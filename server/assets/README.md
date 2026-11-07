# 内置词典资源说明

这里有**三本独立**的词典，随桌面版分发、不进 SQLite，各自可以在设置里单独停用：

| 文件 | 词典 | 条数 | 来源 |
| --- | --- | --- | --- |
| `en-zh.json` | 中英核心词库 | 29,005 | [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）筛选版 |
| `builtin/index.json` + `builtin/<key>.json` | WordNet 英文释义 | 152,431 | [Open English WordNet 2025](https://github.com/globalwordnet/english-wordnet) |
| `phrases.json` | 词组词典 | 8,165 | [Akiyama-sama/english-phrases](https://github.com/Akiyama-sama/english-phrases)（CC BY-SA 4.0） |

三本是**独立数据源**，不在构建期合并：查词时由 `server/src/domain/dictionaries.ts` 把启用中的
命中合成一条释义（词组另排最前 → 中文 → 英英）。停用哪一本，哪一本就不参与合成。

## 加载策略

- **WordNet** 按首字母分成 37 个文件（`a.json` … `z.json`、`0-9` 各自一片、`_.json`），
  `index.json` 记录总量。查词只解析命中的那一片，最多同时保留 8 片。
  合成单文件是 22MB：启动就要 parse 一遍并常驻两百兆堆，桌面端不该这么花内存。
- **中英核心词库**（2.7MB）与**词组词典**（1.2MB）体量小，首次查到才整体读入。
- 缺文件不会阻止应用启动：那本词典降级为空，设置页显示「文件缺失」的说明。

## 运行时路径

- 开发态：`server/assets/`（按 `import.meta.url` 就近查找）
- 打包后：`server/dist/en-zh.json`、`server/dist/builtin/`、`server/dist/phrases.json`（`server/build.mjs` 复制）
- 安装包内：`.../Resources/resources/server/` 下的同名文件（`scripts/stage-sidecar.mjs` 复制）

## 词条结构

```json
{
  "run": {
    "phonetic": "ɹʌn",
    "pos": "nv",
    "meanings": [
      "n. a score in baseball made by a runner touching all four bases safely — the Yankees scored 3 runs",
      "v. move fast by using one's feet"
    ]
  }
}
```

- `meanings`：一行一条。WordNet 的例句用 `— ` 接在释义后面；词组词典的例句以 `例：` 开头。
- `pos`：粗粒度词性（`n` / `v` / `a` / `r`）。**词形还原靠它判断该不该按动词推导**：
  `-ed` 推出的词头必须是动词，否则 `better` 会被拆成 `bet`。中英核心词库没有这个字段，
  运行时从释义行前缀（`n.` / `vt.` / `ad.`）推导；词组没有词性，不参与词形推导。
- 键是 `normalizeVocabularyTerm` 归一化后的小写词头。三本里同一词头撞车没关系——
  正好合成一条：`us` 拿到中文「我们」，也能看到 WordNet 里 `US` 的美国释义。

## 生成方式

三个脚本都在仓库根目录，产物请勿手工编辑：

```bash
# 1. WordNet 分片（默认只出英英释义，中文由 en-zh.json 独立提供）
unzip -q english-wordnet-2025-plus-json.zip -d /tmp/wn
node scripts/build-wordnet-dictionary.mjs --src /tmp/wn --stats
#   加 --merge-legacy 则把 en-zh.json 的中文释义并进产物（会失去「单独关闭中文」的能力）

# 2. 词组词典（上限 6 个词，与查词侧一致）
git clone --depth 1 https://github.com/Akiyama-sama/english-phrases /tmp/english-phrases
node scripts/build-phrase-dictionary.mjs --src /tmp/english-phrases/output/englishPhrase.json
```

注意 `englishPhrase.json` 的字段与它 README 里写的相反：`sCN` 是短语的中文释义，
`tran` 才是例句的中文翻译。构建脚本按真实数据取值。

`en-zh.json` 是上面两个脚本之外的第三本，由旧版仓库流程产出（ECDICT 筛选：`tag` 非空
或词频前 3 万），本仓库只保存产物。

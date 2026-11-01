# 内置词典资源说明

`en-zh.json` 是随桌面版分发的**核心英汉词典**（约 29,005 条），由
`server/src/domain/builtinDictionary.ts` 在进程启动时读入内存，查词时作为
「用户导入词典」之后的第二优先级来源。它不在 SQLite 里，也不需要用户下载。

## 运行时路径

- 开发态：`server/assets/en-zh.json`（`tsx` 直接按源码目录向上查找）
- 打包后：`server/dist/en-zh.json`（`server/build.mjs` 复制）
- 安装包内：`.../Resources/resources/server/en-zh.json`（`scripts/stage-sidecar.mjs` 复制）

缺文件时不会阻止应用启动：词典接口降级为只查用户导入词典，设置页会显示
「内置词典文件缺失」的说明。

## 数据来源

- 词库：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT License，Copyright (c) 2025 Linwei）
- 源文件：`assets/ecdict.csv`（npm 包 `ecdict@0.0.4`，亦可从
  <https://unpkg.com/ecdict@0.0.4/assets/ecdict.csv> 下载）
- 本次生成所用源文件 sha256：
  `d0ce61e560b50d9905d20de3173aa3ca80950ce235bedd21c53e025cf9f38cb0`（65,936,699 字节）

## 筛选规则

保留同时满足以下条件的行：

1. `word` 与 `translation` 均非空；
2. `tag` 非空，**或** `0 < frq <= 30000`（`frq` 为 `0` 表示未知）。

键名使用与 `server/src/lib/englishLearning.ts` 的 `normalizeVocabularyTerm` 一致的算法；
`translation` 按换行切分为多条释义并去除空项。输出为紧凑 JSON：

```json
{ "<归一化词条>": { "meanings": ["中文释义1", "中文释义2"], "phonetic": "ˈfjuːz" } }
```

## 生成方式

生成脚本留在原版仓库（`FeedFuse/scripts/dictionaries/build-core.mjs`），本仓库只保存产物：

```bash
# 在 FeedFuse/ 根目录执行，然后把产物复制到 FeedFuse-rust/server/assets/en-zh.json
pnpm dict:build-core
```

> `en-zh.json` 是生成产物，请勿手工编辑。

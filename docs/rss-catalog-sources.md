# RSS 推荐目录来源

整理日期：2026-10-15。目录共 3740 个订阅地址，保留原有 24 个，新增 3716 个；中文 2095 个、英文 1645 个。

## 公开清单

依照下表顺序合并，地址重复时保留先收录的条目。数量为各清单对本次目录贡献的去重后新增条目数。

| 来源 | 新增条目 | 使用的数据 | 许可 |
| --- | ---: | --- | --- |
| [Tidings RSS](https://github.com/fuxiaoai/tidings-rss) | 699 | data/feeds.json | CC0-1.0 |
| [中文独立博客](https://github.com/timqian/chinese-independent-blogs) | 1061 | blogs-original.csv | MIT |
| [ShinnChow Awesome RSS Feeds](https://github.com/ShinnChow/awesome-rss-feeds) | 1674 | feeds/*.opml | CC0-1.0 |
| [Plenary Awesome RSS Feeds](https://github.com/plenaryapp/awesome-rss-feeds) | 262 | recommended/with_category/*.opml；中英文地区新闻 OPML | CC0-1.0 |
| [Awesome RSSHub Routes](https://github.com/JackyST0/awesome-rsshub-routes) | 20 | feeds.opml | CC0-1.0 |

## 整理方式

- 仅收录公开清单中明确提供的 HTTP/HTTPS RSS 或 Atom 订阅地址；没有猜测订阅路径。
- 按域名、路径与查询参数去重，同时合并 HTTP/HTTPS、www 和末尾斜杠变体；保留具体频道和查询参数不同的地址。
- 过滤明确的 JSON Feed、占位地址和本机/私网 IP 地址，未访问各个订阅端点。
- 原有 24 个条目的标识、介绍和顺序保持不变；新增条目使用地址派生的稳定标识。分类由公开主题与标签整理，简介使用主题描述或博客公开标签。
- 优先使用清单提供的网站主页；清单缺少主页时使用订阅地址的站点首页。同名不同频道补充分类或站点，便于区分。
- 语言来自清单的语言字段或中英文分组；零散清单参考公开名称，可能存在混合语言内容。
- 新增来源未经本项目逐一请求或可用性验证。来源可能停止更新、调整地址、需要订阅或依赖第三方服务；添加订阅仍使用应用原有的校验流程。
- 这是推荐目录扩充，不会自动向用户账号添加订阅，也不会改变订阅刷新、解析或抓取逻辑。

## 分类数量

| 分类 | 条目 |
| --- | ---: |
| 科技互联网 | 23 |
| 人文生活 | 356 |
| 开发设计 | 1821 |
| 新闻时事 | 80 |
| 科学探索 | 68 |
| 人工智能 | 218 |
| 商业财经 | 160 |
| 网络安全 | 26 |
| 播客音频 | 439 |
| 产品设计 | 87 |
| 影视游戏 | 118 |
| 阅读写作 | 49 |
| 生活旅行 | 250 |
| 体育运动 | 45 |

## 中文独立博客许可声明

以下保留该清单的 MIT 许可声明；其他清单的目录数据使用 CC0-1.0。订阅源名称和文章内容的权利归各自发布方所有。

```text
MIT License

Copyright (c) 2019 Tim Qian

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

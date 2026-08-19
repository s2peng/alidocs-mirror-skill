# 钉钉知识库镜像 Skill

这是一个 Codex Skill，用来把钉钉 / 阿里文档知识库节点镜像到本地文件夹。

它适合处理这类需求：

- 按线上目录结构批量下载钉钉知识库资料。
- 将 `alidocs.dingtalk.com` 节点保存到本地指定文件夹。
- 将微信公众号 / 微信推文链接保存为 PDF。
- 当微信推文已经保存为 PDF 后，清理对应的 `txt` 或 `.url.txt` 链接占位文件。
- 生成本地镜像报告和在线链接索引，方便后续核对。

## 安装方式

### 让 Codex 从 GitHub 安装

可以直接把下面这段发给 Codex：

```text
$skill-installer 请从 GitHub 安装这个 Codex Skill：
https://github.com/s2peng/alidocs-mirror

说明：
- 这个仓库根目录就是 Skill 目录
- 安装路径 path 用 `.`
- 安装后的 Skill 名称用 `alidocs-mirror`
- 安装到默认的 Codex skills 目录
- 安装完成后告诉我下一轮怎么触发使用
```

安装完成后，下一轮对话即可使用 `$alidocs-mirror` 触发。

### 手动安装

把整个仓库目录安装到 Codex 的 skills 目录下，并确保文件夹名是 `alidocs-mirror`。

Windows 示例：

```text
%USERPROFILE%\.codex\skills\alidocs-mirror
```

macOS / Linux 示例：

```text
~/.codex/skills/alidocs-mirror
```

安装完成后，重启或刷新 Codex，让它重新读取 Skill。

## 如何触发

最稳的方式是在需求开头直接写 Skill 名：

```text
$alidocs-mirror 帮我把这个钉钉知识库链接镜像到 <本地保存路径>，保留目录结构，微信推文保存成 PDF，有 PDF 的 txt 链接文件就删掉。
```

也可以用自然语言触发，例如：

```text
帮我把这个 alidocs.dingtalk.com 知识库下载到本地，保留文件夹结构，微信推文另存为 PDF。
```

自然语言触发依赖 Codex 对任务语义的判断，不是硬编码关键词规则。对外分享或多人协作时，建议优先使用 `$alidocs-mirror`。

## 使用前提

- 需要在浏览器中登录钉钉 / 阿里文档账号。
- 用户需要提供一个钉钉知识库或节点链接。
- 用户需要提供一个本地保存路径。
- Codex 需要能控制已登录的浏览器页面。

如果页面提示未登录，先让用户登录，登录完成后再继续镜像。

## 输出内容

镜像完成后，本地目录通常会包含：

- 下载得到的原始文件。
- 微信推文转换得到的 PDF。
- `_alidocs_tree.json`：线上目录结构记录。
- `_mirror_report.md`：下载与处理结果报告。
- `_在线文档与链接入口索引.md`：仍需保留的在线文档或网页入口。

## 默认处理规则

- 保留线上文件夹结构。
- 优先通过文件行右侧的三个点菜单下载。
- 如果菜单下载失败，再尝试从预览页下载。
- 微信公众号文章尽量保存成 PDF。
- 已经成功保存为 PDF 的微信链接，不再保留对应的文本占位文件。
- 非微信网页、动态图集、在线目录等不一定适合保存为 PDF，默认保留链接入口。

## 文件结构

```text
alidocs-mirror/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/
│   └── zh-usage.md
└── scripts/
    ├── alidocs_browser_mirror.mjs
    ├── postprocess_link_entries.mjs
    └── save_web_links_as_pdf.mjs
```

## 注意事项

- 这个 Skill 只提供自动化镜像流程，不绕过权限控制。
- 只能下载当前登录账号有权限访问的内容。
- 上传公开仓库前，应确认仓库中不包含个人路径、客户资料、账号信息或私有下载内容。

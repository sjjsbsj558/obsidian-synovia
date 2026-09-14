export function wikiLink(path: string, title?: string): string {
  const target = path.replace(/\.md$/iu, "");
  if (/[\[\]#|^\r\n]/u.test(target)) throw new Error("笔记路径包含不支持的链接字符");
  return `[[${target}${title ? `|${title.replace(/[\[\]|\r\n]/gu, " ")}` : ""}]]`;
}

export function topicPath(root: string, name: string): string {
  const title = name.trim();
  if (!title || title.length > 80 || /[<>:"/\\|?*#^[\]\u0000-\u001f]/u.test(title)
    || /[. ]$/u.test(title) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(title)) {
    throw new Error("主题名需为 1–80 字，不能包含路径或链接特殊字符");
  }
  return `${root}/Topics/${title}.md`;
}

export function managedSection(before: string, section: string, body: string): string {
  const start = `<!-- synovia:${section}:start -->`;
  const end = `<!-- synovia:${section}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const a = before.indexOf(start);
  const b = before.indexOf(end);
  if (a < 0 && b < 0) return `${before.trimEnd()}\n\n${block}\n`;
  if (a < 0 || b < a || before.indexOf(start, a + 1) >= 0 || before.indexOf(end, b + 1) >= 0) {
    throw new Error("Synovia 索引区标记已改变，请人工检查；未覆盖笔记");
  }
  return before.slice(0, a) + block + before.slice(b + end.length);
}

export function topicNote(title: string, root: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ntype: topic\ntags: [synovia/topic]\n---\n\n# ${title}\n\n${wikiLink(`${root}/知识库首页`)}\n\n## 我的整理\n\n`;
}

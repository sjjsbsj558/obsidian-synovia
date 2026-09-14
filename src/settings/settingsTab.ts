import { Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { App } from "obsidian";
import type SynoviaPlugin from "../main";
import { SettingsSchema } from "./settings";

export class SynoviaSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SynoviaPlugin) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();
    const draft = { ...this.plugin.settings };
    new Setting(this.containerEl).setName("Synovia").setHeading();
    new Setting(this.containerEl).setName("Wiki 目录")
      .addText((text) => text.setValue(draft.wikiRoot).onChange((value) => { draft.wikiRoot = value; }));
    new Setting(this.containerEl).setName("候选笔记数量")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "20";
        text.setValue(String(draft.topK)).onChange((value) => { draft.topK = Number(value); });
      });
    new Setting(this.containerEl).setName("BM25 最低分数")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.step = "0.1";
        text.setValue(String(draft.minScore)).onChange((value) => { draft.minScore = Number(value); });
      });
    new Setting(this.containerEl).setName("模型与数据").setHeading();
    new Setting(this.containerEl).setName("允许远程调用")
      .setDesc("允许观点 Agent 按问题读取本地笔记，并向所配置的模型服务发送必要内容；也允许知乎检索功能发送查询。")
      .addToggle((toggle) => toggle.setValue(draft.allowRemote).onChange((value) => { draft.allowRemote = value; }));
    new Setting(this.containerEl).setName("自动整理全库")
      .setDesc("当前版本不在后台自动调用模型；全库整理仅通过维护界面的手动操作启动。")
      .addToggle((toggle) => toggle.setValue(draft.autoOptimize).onChange((value) => { draft.autoOptimize = value; }));
    new Setting(this.containerEl).setName("发送前脱敏")
      .setDesc("替换常见邮箱、手机号和密钥格式；不能识别所有敏感信息。")
      .addToggle((toggle) => toggle.setValue(draft.redactSensitive).onChange((value) => { draft.redactSensitive = value; }));
    new Setting(this.containerEl).setName("兼容 Chat Completions 的服务根地址")
      .setDesc("包含版本前缀，例如 https://服务域名/v1；也可填写完整 /chat/completions 地址。")
      .addText((text) => text.setPlaceholder("https://...")
        .setValue(draft.modelBaseUrl).onChange((value) => { draft.modelBaseUrl = value.trim(); }));
    new Setting(this.containerEl).setName("模型名称")
      .addText((text) => text.setValue(draft.modelName).onChange((value) => { draft.modelName = value; }));
    new Setting(this.containerEl).setName("模型密钥")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(draft.modelSecretName)
        .onChange((value) => { draft.modelSecretName = value; }));
    new Setting(this.containerEl).setName("知乎密钥（CLI 已登录时可留空）")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(draft.zhihuSecretName)
        .onChange((value) => { draft.zhihuSecretName = value; }));
    new Setting(this.containerEl).setName("知乎连接方式")
      .addDropdown((dropdown) => dropdown.addOptions({ cli: "知乎 CLI / Skill", api: "HTTP 搜索 API", mcp: "MCP SSE" })
        .setValue(draft.zhihuMode).onChange((value) => {
          if (value === "cli" || value === "api" || value === "mcp") draft.zhihuMode = value;
        }));
    new Setting(this.containerEl).setName("知乎 CLI 命令")
      .setDesc("默认 zhihu-cli；Windows 自动识别官方安装位置，也可填可执行文件绝对路径。沿用 CLI 系统凭据库认证，无需重复填写密钥。")
      .addText((text) => text.setValue(draft.zhihuCommand).onChange((value) => { draft.zhihuCommand = value.trim(); }));
    new Setting(this.containerEl).setName("全网搜索过滤器")
      .setDesc('例如 host=="example.com"；留空表示不筛选。')
      .addText((text) => text.setValue(draft.zhihuGlobalFilter).onChange((value) => { draft.zhihuGlobalFilter = value; }));
    new Setting(this.containerEl).setName("全网搜索索引")
      .addDropdown((dropdown) => dropdown.addOptions({ all: "全部", realtime: "实时", static: "静态" })
        .setValue(draft.zhihuGlobalDb).onChange((value) => {
          if (value === "all" || value === "realtime" || value === "static") draft.zhihuGlobalDb = value;
        }));
    new Setting(this.containerEl).setName("知乎直答模型")
      .addDropdown((dropdown) => dropdown.addOptions({ fast: "快速", thinking: "思考", agent: "Agent" })
        .setValue(draft.zhidaModel).onChange((value) => {
          if (value === "fast" || value === "thinking" || value === "agent") draft.zhidaModel = value;
        }));
    const numeric = (
      label: string,
      key: "timeoutSeconds" | "maxInputChars" | "maxOutputTokens" | "zhihuCount" | "zhihuGlobalCount" | "zhihuHotCount",
      min: number, max: number, step = 1
    ) => new Setting(this.containerEl).setName(label).addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(min);
      text.inputEl.max = String(max);
      text.inputEl.step = String(step);
      text.setValue(String(draft[key])).onChange((value) => { draft[key] = Number(value); });
    });
    numeric("知乎搜索条数", "zhihuCount", 1, 10);
    numeric("全网搜索条数", "zhihuGlobalCount", 1, 20);
    numeric("知乎热榜条数", "zhihuHotCount", 1, 30);
    numeric("请求超时（秒）", "timeoutSeconds", 10, 300);
    numeric("每次模型请求的输入字符上限", "maxInputChars", 1000, 100_000);
    numeric("每次模型请求的输出 Token 上限", "maxOutputTokens", 512, 16_000);
    new Setting(this.containerEl).addButton((button) => button.setButtonText("保存设置").setCta()
      .onClick(async () => {
        const parsed = SettingsSchema.safeParse(draft);
        if (!parsed.success) {
          new Notice(`配置未保存：${parsed.error.issues[0]?.message ?? "输入无效"}`);
          return;
        }
        button.setDisabled(true);
        try {
          await this.plugin.updateSettings(parsed.data);
          new Notice("Synovia 设置已保存");
        } catch {
          new Notice("设置保存失败，原配置未改变");
        } finally {
          button.setDisabled(false);
        }
      }));
  }
}

import fs from "node:fs";
import path from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "./kb-config.mjs";
import { KnowledgeBase, KINDS, KB_DIR_NAME, parseEntryId } from "./kb-store.mjs";

const OUTLINE_NAME = "00-开始这里-总纲.md";
const INDEX_NAME = { 方法: "00-方法主体.md", 避错: "00-避错主体.md" };

const OUTLINE_TEXT = `# 知识库总纲

本目录是**项目级知识库**：可复用的做法放「方法/」，踩过的坑放「避错/」。

## 结构

\`\`\`
知识库/
├── 00-开始这里-总纲.md      ← 本文件
├── 方法/
│   ├── 00-方法主体.md
│   └── 方法-01-【领域】.md
└── 避错/
    ├── 00-避错主体.md
    └── 避错-01-【领域】.md
\`\`\`

## 规则

- \`M-0XX\` = 方法，\`P-0XX\` = 避错；三位数从 001 起，只增不改。
- 按领域分册，不按时间分册；每册装满即开新册。
- 每新增一条，必须同步更新对应的主体索引。
- 避错条目四段必填：触发条件 / 先做 / 为什么 / 违规症状。
- 可用工具：kb_guide / kb_search / kb_add / kb_list / kb_get / kb_remove / kb_prune / kb_init。

动手前先用 \`kb_guide\` 按正在做的事查；要回答「这个项目以前提过吗」用 \`kb_search\`。
`;

function safeId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "default";
}

function defaultIndex(kind, volumePerBook) {
  return `# ${kind}分册索引\n\n` +
    `> 落笔规则：按**领域**分册（不按时间）；每册约 ${volumePerBook} 条，装满即开新册；\n` +
    `> 编号全局连续、只增不改。每新增一条，**必须同步更新下表**。\n\n` +
    `| 册名 | 覆盖领域 | 编号区间 | 什么时候读它 |\n|---|---|---|---|\n`;
}

function formatEntryLine(entry) {
  const trigger = entry.trigger ? `触发：${entry.trigger}` : "";
  const steps = Array.isArray(entry.steps) && entry.steps.length
    ? `先做：${entry.steps.slice(0, 3).join("；")}`
    : "";
  const why = entry.why ? `为什么：${entry.why}` : "";
  return [`### ${entry.id} ${entry.title}`, [trigger, steps, why].filter(Boolean).join("\n")].filter(Boolean).join("\n");
}

export function createKnowledgeService({ configDir }) {
  const dataDir = path.join(configDir, "knowledge-plugin");
  const fallbackRoots = path.join(configDir, "project-knowledge");
  const configStore = new ConfigStore(dataDir);
  configStore.load();
  const cache = new Map();

  function settingsFile() {
    return path.join(configDir, "settings.json");
  }

  function pluginEnabled() {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      return settings?.plugins?.knowledge?.enabled !== false;
    } catch {
      return true;
    }
  }

  function context(raw = {}) {
    const projectId = safeId(raw.projectId);
    const projectName = String(raw.projectName || "").trim() || "默认项目";
    const provided = String(raw.projectRoot || "").trim();
    const projectRoot = provided
      ? path.resolve(provided)
      : path.join(fallbackRoots, projectId);
    return { projectId, projectName, projectRoot };
  }

  function kbFor(ctx) {
    const key = `${ctx.projectRoot.toLowerCase()}|${ctx.projectName}`;
    let kb = cache.get(key);
    const config = configStore.get();
    if (!kb) {
      kb = new KnowledgeBase(ctx.projectRoot, config, ctx.projectName);
      cache.set(key, kb);
    } else {
      kb.applyConfig(config);
    }
    return kb;
  }

  function existingKb(ctx) {
    const kb = kbFor(ctx);
    if (!fs.existsSync(kb.dir)) return null;
    kb.load();
    return kb;
  }

  function counts(kb) {
    const list = kb.list();
    return {
      方法: list.filter((entry) => entry.kind === "方法").length,
      避错: list.filter((entry) => entry.kind === "避错").length,
      total: list.length
    };
  }

  async function init(ctx, raw = {}) {
    const kb = kbFor(ctx);
    try {
      fs.mkdirSync(kb.projectRoot, { recursive: true });
      fs.mkdirSync(kb.dir, { recursive: true });
      for (const kind of KINDS) {
        fs.mkdirSync(path.join(kb.dir, kind), { recursive: true });
      }
      const created = [];
      const outline = path.join(kb.dir, OUTLINE_NAME);
      if (!fs.existsSync(outline)) {
        fs.writeFileSync(outline, OUTLINE_TEXT, "utf8");
        created.push(OUTLINE_NAME);
      }
      for (const kind of KINDS) {
        const index = path.join(kb.dir, kind, INDEX_NAME[kind]);
        if (!fs.existsSync(index)) {
          fs.writeFileSync(index, defaultIndex(kind, kb.volumePerBook), "utf8");
          created.push(`${kind}/${INDEX_NAME[kind]}`);
        }
      }
      kb.load();
      return { ok: true, dir: kb.dir, created, ...describe(ctx) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), dir: kb.dir };
    }
  }

  function describe(ctx) {
    const kb = kbFor(ctx);
    const exists = fs.existsSync(kb.dir);
    if (exists) kb.load();
    return {
      ok: true,
      exists,
      dir: kb.dir,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      projectRoot: ctx.projectRoot,
      counts: exists ? counts(kb) : { 方法: 0, 避错: 0, total: 0 },
      books: exists ? { 方法: Object.keys(kb.state.books.方法).length, 避错: Object.keys(kb.state.books.避错).length } : { 方法: 0, 避错: 0 },
      config: configStore.get(),
      lastError: kb.lastError || ""
    };
  }

  function browse(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, dir: kbFor(ctx).dir, entries: [], counts: { 方法: 0, 避错: 0, total: 0 }, config: configStore.get() };
    const summary = kb.list();
    const entries = summary.map((entry) => {
      const full = kb.get(entry.id) || {};
      return { ...full, kind: entry.kind, domain: entry.domain, book: entry.book };
    }).sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return { ok: true, exists: true, dir: kb.dir, entries, counts: counts(kb), config: configStore.get() };
  }

  function search(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, entries: [], dir: kbFor(ctx).dir };
    const limit = Number.isInteger(raw.limit) ? raw.limit : configStore.get().searchLimit;
    return {
      ok: true,
      exists: true,
      entries: kb.search({
        text: raw.text ?? raw.query ?? "",
        kind: raw.kind,
        domain: raw.domain,
        limit
      })
    };
  }

  function guide(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, entries: [], dir: kbFor(ctx).dir };
    const result = kb.guide({
      task: raw.task ?? raw.query ?? "",
      stage: raw.stage,
      kind: raw.kind,
      limit: raw.limit,
      exclude: raw.exclude
    });
    return { ...result, ok: true, exists: true };
  }

  function get(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库", dir: kbFor(ctx).dir };
    const entry = kb.get(String(raw.id || ""));
    return entry ? { ok: true, entry } : { ok: false, error: `没有编号 ${raw.id || ""}` };
  }

  async function add(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库，请先初始化（kb_init）", dir: kbFor(ctx).dir };
    const kind = raw.kind === "方法" || raw.kind === "避错" ? raw.kind : configStore.get().defaultKind;
    const entry = raw.entry && typeof raw.entry === "object" ? raw.entry : raw;
    const id = String(raw.id || entry.id || "").trim();
    if (id && parseEntryId(id)) {
      return update(ctx, { ...raw, kind, id, entry: { ...entry, id } });
    }
    const result = await kb.write(kind, entry);
    if (result.ok) {
      const pruned = await kb.pruneIfNeeded();
      return { ...result, kind, pruned: pruned.pruned || [] };
    }
    return result;
  }

  async function update(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    const kind = raw.kind === "方法" || raw.kind === "避错" ? raw.kind : configStore.get().defaultKind;
    const id = String(raw.id || "").trim();
    if (!parseEntryId(id)) return { ok: false, error: "编号格式不对" };
    const remove = await kb.remove(id);
    if (!remove.ok) return remove;
    const entry = raw.entry && typeof raw.entry === "object" ? raw.entry : raw;
    const result = await kb.write(kind, { ...entry, id });
    if (result.ok) return { ...result, kind, updated: true };
    return result;
  }

  async function remove(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    return kb.remove(String(raw.id || ""));
  }

  async function prune(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    const keep = Number.isInteger(raw.keep) ? raw.keep : 0;
    return kb.prune(keep);
  }

  function saveConfig(raw = {}) {
    return (async () => {
      const result = await configStore.save(raw);
      if (result.ok) {
        for (const kb of cache.values()) kb.applyConfig(result.config);
      }
      return result;
    })();
  }

  function inject(ctx, raw = {}) {
    const cfg = configStore.get();
    const kb = kbFor(ctx);
    const exists = fs.existsSync(kb.dir);
    if (exists) kb.load();
    const parts = [];
    if (cfg.injectEnabled) {
      const outline = exists && kb.state.outline ? kb.state.outline : OUTLINE_TEXT;
      const cap = Math.max(200, Math.min(20000, Number(cfg.injectMaxChars) || 6000));
      parts.push("## 知识库使用约定\n\n" + (outline.length > cap ? `${outline.slice(0, cap)}\n\n（总纲已按设置的字数上限截断）` : outline));
    }
    if (cfg.guideInjectEnabled && exists && raw.task) {
      const result = kb.guide({ task: raw.task, stage: raw.stage, limit: cfg.guideInjectLimit });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (entries.length) {
        parts.push("## 本项目必读（按当前任务匹配）\n\n" + entries.map(formatEntryLine).join("\n\n"));
      }
    } else if (cfg.guideInjectEnabled && !exists) {
      parts.push("## 本项目知识库\n\n这个项目还没有知识库。需要时先调用 `kb_init` 建骨架，再沉淀。");
    }
    return { text: parts.join("\n\n").trim() };
  }

  async function invoke(action, raw = {}, project = {}) {
    if (!pluginEnabled()) {
      return { ok: false, error: "知识库插件当前未启用" };
    }
    const ctx = context(project);
    switch (action) {
      case "describe": return describe(ctx);
      case "browse": return browse(ctx, raw);
      case "search": return search(ctx, raw);
      case "guide": return guide(ctx, raw);
      case "get": return get(ctx, raw);
      case "add": return add(ctx, raw);
      case "update": return update(ctx, raw);
      case "remove": return remove(ctx, raw);
      case "prune": return prune(ctx, raw);
      case "init": return init(ctx, raw);
      case "config": return { ok: true, config: configStore.get(), ...describe(ctx) };
      case "saveConfig": return saveConfig(raw);
      case "resetConfig": return saveConfig({ ...DEFAULT_CONFIG });
      case "inject": return inject(ctx, raw);
      default: return { ok: false, error: `未知知识库操作：${action}` };
    }
  }

  async function runTool(name, args = {}, project = {}) {
    const ctx = context(project);
    if (!pluginEnabled()) return JSON.stringify({ ok: false, error: "知识库插件当前未启用" });
    const map = {
      kb_list: "browse",
      kb_search: "search",
      kb_guide: "guide",
      kb_get: "get",
      kb_add: "add",
      kb_remove: "remove",
      kb_prune: "prune",
      kb_init: "init"
    };
    const action = map[name];
    if (!action) throw new Error(`未知知识库工具：${name}`);
    const result = await invoke(action, args, project);
    if (result && result.entries && result.entries.length && action !== "browse") {
      result.entries = result.entries.map((entry) => {
        if (entry.id) return entry;
        return entry;
      });
    }
    return JSON.stringify(result, null, 2);
  }

  return { invoke, runTool, context, describe, inject, config: () => configStore.get() };
}

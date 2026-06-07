import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

const DEFAULT_URL =
  "https://oucbk.yuketang.cn/pro/lms/Bj7NPVxCMsq/23211136/exam/45810085";

const ROOT = process.cwd();
const BANK_FILE = path.join(ROOT, "question_bank.json");
const DOCX_FILE = path.join(ROOT, "习思题库.docx");
const LOG_FILE = path.join(ROOT, "capture.log");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");

const args = parseArgs(process.argv.slice(2));
const config = {
  url: args.url || DEFAULT_URL,
  staleRounds: toPositiveInt(args["stale-rounds"], 4),
  maxRounds: args["max-rounds"] ? toPositiveInt(args["max-rounds"], 0) : 0,
  exportOnly: Boolean(args["export-only"]),
  watch: Boolean(args.watch),
};

const answerKeys = new Set([
  "answer",
  "answers",
  "correct_answer",
  "correctAnswer",
  "right_answer",
  "rightAnswer",
  "standard_answer",
  "standardAnswer",
  "reference_answer",
  "referenceAnswer",
]);

const analysisKeys = new Set([
  "analysis",
  "解析",
  "explanation",
  "explain",
  "solution",
  "comment",
]);

const questionKeys = new Set([
  "question",
  "questions",
  "problem",
  "problems",
  "subject",
  "subjects",
  "item",
  "items",
]);

main().catch((error) => {
  log(`ERROR ${error.stack || error.message || error}`);
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const bank = loadBank();

  if (config.exportOnly) {
    await exportDocx(bank);
    console.log(`已导出：${DOCX_FILE}`);
    return;
  }

  log("capture started");
  const rl = readline.createInterface({ input, output });
  const pendingPayloads = [];

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1366, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());
  attachResponseCollector(page, pendingPayloads);
  context.on("page", (newPage) => attachResponseCollector(newPage, pendingPayloads));

  await page.goto(config.url, { waitUntil: "domcontentloaded" });

  if (config.watch) {
    await runWatchMode(context, page, pendingPayloads, bank);
    return;
  }

  console.log("浏览器已打开。请手动登录，并进入 10 题页面。");
  await ask(rl, "题目加载完成后按 Enter 开始采集本轮题目；输入 q 退出：");

  let round = 1;
  let staleRounds = 0;

  while (true) {
    if (config.maxRounds && round > config.maxRounds) {
      log(`stop: max rounds ${config.maxRounds}`);
      break;
    }

    console.log(`\n第 ${round} 轮：正在采集题目与选项...`);
    const before = await collectRound(page, pendingPayloads, round, "questions");
    const beforeResult = mergeQuestions(bank, before);
    logRound(round, "questions", beforeResult);
    await saveAndExport(bank);

    const afterPrompt =
      "请在网页里正常提交/查看结果。答案或解析出现后按 Enter；输入 s 跳过结果采集，输入 q 结束：";
    const afterAnswer = await ask(rl, afterPrompt);
    if (afterAnswer === "q") break;

    let afterResult = { added: 0, updated: 0, repeated: 0 };
    if (afterAnswer !== "s") {
      console.log(`第 ${round} 轮：正在补充答案与解析...`);
      const after = await collectRound(page, pendingPayloads, round, "results");
      afterResult = mergeQuestions(bank, after);
      logRound(round, "results", afterResult);
      await saveAndExport(bank);
    }

    const changed = beforeResult.added + beforeResult.updated + afterResult.added + afterResult.updated;
    staleRounds = changed > 0 ? 0 : staleRounds + 1;
    console.log(
      `本轮新增 ${beforeResult.added + afterResult.added}，更新 ${beforeResult.updated + afterResult.updated}，当前共 ${bank.questions.length} 题。`
    );

    if (staleRounds >= config.staleRounds) {
      log(`stop: stale rounds ${staleRounds}`);
      console.log(`连续 ${staleRounds} 轮没有新增或更新题目，已停止。`);
      break;
    }

    const next = await ask(
      rl,
      "请在网页里进入下一组 10 题，加载完成后按 Enter 继续；输入 q 结束："
    );
    if (next === "q") break;
    round += 1;
  }

  await saveAndExport(bank);
  await context.close();
  rl.close();
  log("capture finished");
  console.log(`\n完成。题库：${DOCX_FILE}`);
}

async function runWatchMode(context, page, pendingPayloads, bank) {
  console.log("自动监听模式已启动。请在打开的浏览器中手动登录并操作题目页面。");
  console.log("脚本会自动点击明显的“开始答题/继续答题”按钮，并持续导出 Word。按 Ctrl+C 结束。");
  log("watch mode started");

  let round = 1;
  let idleTicks = 0;

  const stop = async () => {
    await saveAndExport(bank);
    await context.close().catch(() => {});
    log("watch mode stopped");
    console.log(`\n已保存：${DOCX_FILE}`);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (true) {
    await maybeClickStart(page);
    const questions = await collectRound(page, pendingPayloads, round, "watch");
    const result = mergeQuestions(bank, questions);
    if (result.added || result.updated) {
      idleTicks = 0;
      logRound(round, "watch", result);
      await saveAndExport(bank);
      console.log(
        `[第 ${round} 次扫描] 新增 ${result.added}，更新 ${result.updated}，累计 ${bank.questions.length} 题。`
      );
    } else {
      idleTicks += 1;
      if (idleTicks % 6 === 0) {
        console.log(`[监听中] 当前累计 ${bank.questions.length} 题，最近没有发现新题。`);
      }
    }
    round += 1;
    await page.waitForTimeout(5000);
  }
}

async function maybeClickStart(page) {
  const labels = [
    "开始答题",
    "开始考试",
    "进入考试",
    "继续答题",
    "继续考试",
    "立即开始",
    "去答题",
  ];

  for (const label of labels) {
    const locator = page.getByText(label, { exact: false }).first();
    try {
      if (await locator.isVisible({ timeout: 300 })) {
        await locator.click({ timeout: 1500 });
        log(`clicked ${label}`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {
      // The page may rerender while probing; continue with the next label.
    }
  }
  return false;
}

function attachResponseCollector(page, pendingPayloads) {
  page.on("response", async (response) => {
    const url = response.url();
    if (!looksRelevantUrl(url)) return;

    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    if (!contentType.includes("json")) return;

    try {
      const json = await response.json();
      pendingPayloads.push({ url, json, capturedAt: new Date().toISOString() });
      if (pendingPayloads.length > 300) pendingPayloads.splice(0, pendingPayloads.length - 300);
      log(`captured response ${url}`);
    } catch {
      // Some endpoints label streaming or encrypted bodies as JSON. Ignore those.
    }
  });
}

async function collectRound(page, pendingPayloads, round, stage) {
  await page.waitForTimeout(1200);
  const payloads = pendingPayloads.splice(0, pendingPayloads.length);
  const fromNetwork = payloads.flatMap((payload) =>
    extractQuestionsFromValue(payload.json, {
      source: "network",
      sourceUrl: payload.url,
      round,
      stage,
    })
  );
  const fromDom = await extractQuestionsFromDom(page, round, stage);
  return [...fromNetwork, ...fromDom].filter((question) => question.title || question.options.length);
}

async function extractQuestionsFromDom(page, round, stage) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visibleText = (node) => clean(node.innerText || node.textContent || "");
    const optionPattern = /^([A-Ha-h])[\s.、:：)）]+(.+)$/;
    const questionSelector = [
      "[class*=question]",
      "[class*=Question]",
      "[class*=problem]",
      "[class*=Problem]",
      "[class*=subject]",
      "[class*=Subject]",
      "[class*=exam]",
      "[class*=Exam]",
      "li",
      "section",
      "article",
    ].join(",");

    const nodes = Array.from(document.querySelectorAll(questionSelector));
    const candidates = [];
    const seen = new Set();

    for (const node of nodes) {
      const text = visibleText(node);
      if (text.length < 12 || text.length > 6000) continue;
      if (seen.has(text)) continue;
      seen.add(text);

      const lines = text
        .split(/\n|(?=[A-Ha-h][\s.、:：)）])/)
        .map(clean)
        .filter(Boolean);
      const options = [];
      const titleLines = [];
      let answer = "";
      let analysis = "";

      for (const line of lines) {
        const optionMatch = line.match(optionPattern);
        if (optionMatch) {
          options.push({ label: optionMatch[1].toUpperCase(), text: optionMatch[2] });
          continue;
        }

        if (/^(正确答案|答案|参考答案|标准答案)[:：]/.test(line)) {
          answer = line.replace(/^(正确答案|答案|参考答案|标准答案)[:：]\s*/, "");
          continue;
        }

        if (/^(解析|答案解析|题目解析)[:：]/.test(line)) {
          analysis = line.replace(/^(解析|答案解析|题目解析)[:：]\s*/, "");
          continue;
        }

        titleLines.push(line);
      }

      if (options.length || /答案|解析/.test(text)) {
        candidates.push({
          title: titleLines.join(" "),
          options,
          answer,
          analysis,
          rawText: text,
        });
      }
    }

    return candidates;
  });

  return data.map((item) => normalizeQuestion(item, { source: "dom", round, stage }));
}

function extractQuestionsFromValue(value, meta, pathParts = []) {
  const found = [];
  if (!value || typeof value !== "object") return found;

  if (Array.isArray(value)) {
    for (const item of value) found.push(...extractQuestionsFromValue(item, meta, pathParts));
    return found;
  }

  const maybe = normalizeQuestion(value, meta);
  if (maybe.title || maybe.options.length || maybe.answer || maybe.analysis) {
    if (looksLikeQuestionObject(value, maybe)) found.push(maybe);
  }

  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== "object") continue;
    const childPath = [...pathParts, key];
    if (questionKeys.has(key) || childPath.length < 7) {
      found.push(...extractQuestionsFromValue(child, meta, childPath));
    }
  }

  return found;
}

function normalizeQuestion(raw, meta) {
  const title = firstText(raw, [
    "title",
    "stem",
    "content",
    "body",
    "question",
    "question_content",
    "questionContent",
    "name",
    "text",
    "subject",
  ]);
  const options = normalizeOptions(
    raw.options ||
      raw.option ||
      raw.choices ||
      raw.choice ||
      raw.answers ||
      raw.answer_list ||
      raw.answerList ||
      raw.items ||
      []
  );
  const answer = findByKeys(raw, answerKeys);
  const analysis = findByKeys(raw, analysisKeys);
  const id = firstText(raw, [
    "id",
    "question_id",
    "questionId",
    "problem_id",
    "problemId",
    "subject_id",
    "subjectId",
  ]);
  const type = firstText(raw, ["type", "question_type", "questionType", "problem_type", "category"]);

  return {
    id: scalar(id),
    title: cleanText(title),
    options,
    answer: cleanAnswer(answer),
    analysis: cleanText(analysis),
    type: cleanText(type),
    rawText: cleanText(raw.rawText),
    firstSeenRound: meta.round,
    lastSeenRound: meta.round,
    stages: [meta.stage].filter(Boolean),
    sources: [
      {
        source: meta.source,
        url: meta.sourceUrl || "",
        capturedAt: new Date().toISOString(),
      },
    ],
  };
}

function looksLikeQuestionObject(raw, normalized) {
  const keys = Object.keys(raw);
  const hasQuestionKey = keys.some((key) =>
    /question|problem|subject|stem|option|choice|answer|analysis|解析/i.test(key)
  );
  const hasEnoughText = normalized.title.length >= 8 || normalized.options.length >= 2;
  return hasQuestionKey && hasEnoughText;
}

function normalizeOptions(value) {
  const arr = Array.isArray(value) ? value : typeof value === "object" && value ? Object.values(value) : [];
  return arr
    .map((item, index) => {
      if (typeof item === "string" || typeof item === "number") {
        return { label: String.fromCharCode(65 + index), text: cleanText(item) };
      }
      if (!item || typeof item !== "object") return null;
      const label = cleanText(item.label || item.key || item.name || item.option || item.code) || String.fromCharCode(65 + index);
      const text = firstText(item, ["text", "content", "title", "value", "name", "answer"]);
      return { label: label.replace(/[.、:：)）]/g, "").slice(0, 4), text: cleanText(text) };
    })
    .filter((option) => option && option.text);
}

function mergeQuestions(bank, incoming) {
  const result = { added: 0, updated: 0, repeated: 0 };
  for (const question of incoming) {
    const key = makeQuestionKey(question);
    if (!key) continue;

    const existing = bank.questions.find((item) => item.key === key);
    if (!existing) {
      bank.questions.push({
        key,
        ...question,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      result.added += 1;
      continue;
    }

    const changed = mergeInto(existing, question);
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      result.updated += 1;
    } else {
      result.repeated += 1;
    }
  }

  bank.questions.sort((a, b) => {
    const roundA = a.firstSeenRound || 0;
    const roundB = b.firstSeenRound || 0;
    if (roundA !== roundB) return roundA - roundB;
    return String(a.title).localeCompare(String(b.title), "zh-Hans-CN");
  });
  bank.updatedAt = new Date().toISOString();
  return result;
}

function mergeInto(existing, incoming) {
  let changed = false;
  for (const field of ["id", "title", "answer", "analysis", "type", "rawText"]) {
    if (!existing[field] && incoming[field]) {
      existing[field] = incoming[field];
      changed = true;
    }
  }

  if ((!existing.options || existing.options.length < incoming.options.length) && incoming.options.length) {
    existing.options = incoming.options;
    changed = true;
  }

  existing.lastSeenRound = Math.max(existing.lastSeenRound || 0, incoming.lastSeenRound || 0);
  existing.stages = Array.from(new Set([...(existing.stages || []), ...(incoming.stages || [])]));
  existing.sources = [...(existing.sources || []), ...(incoming.sources || [])].slice(-12);
  return changed;
}

async function saveAndExport(bank) {
  fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2), "utf8");
  await exportDocx(bank);
}

async function exportDocx(bank) {
  const children = [
    new Paragraph({
      text: "习思题库",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun(`题目总数：${bank.questions.length}`),
        new TextRun({ text: `    更新时间：${new Date().toLocaleString("zh-CN")}`, break: 0 }),
      ],
    }),
  ];

  bank.questions.forEach((question, index) => {
    children.push(
      new Paragraph({
        text: `${index + 1}. ${question.title || question.rawText || "未识别题干"}`,
        heading: HeadingLevel.HEADING_2,
      })
    );

    if (question.type) children.push(labelParagraph("题型", question.type));
    for (const option of question.options || []) {
      children.push(new Paragraph(`${option.label}. ${option.text}`));
    }
    children.push(labelParagraph("正确答案", question.answer || "未采集到"));
    children.push(labelParagraph("解析", question.analysis || "未采集到"));
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `来源：第 ${question.firstSeenRound || "?"} 轮；最后出现：第 ${question.lastSeenRound || "?"} 轮`,
            italics: true,
            size: 20,
          }),
        ],
      })
    );
  });

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(DOCX_FILE, buffer);
}

function labelParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}：`, bold: true }),
      new TextRun(String(value || "")),
    ],
  });
}

function loadBank() {
  if (!fs.existsSync(BANK_FILE)) {
    return { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), questions: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(BANK_FILE, "utf8"));
  parsed.questions ||= [];
  return parsed;
}

function makeQuestionKey(question) {
  if (question.id) return `id:${question.id}`;
  const base = `${question.title || question.rawText}|${(question.options || [])
    .map((option) => `${option.label}:${option.text}`)
    .join("|")}`;
  const normalized = cleanText(base).toLowerCase();
  if (normalized.length < 8) return "";
  return `hash:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function firstText(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return stringifyValue(value[key]);
  }
  return "";
}

function findByKeys(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return "";
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key)) return stringifyValue(child);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findByKeys(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function stringifyValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    return cleanText(value.text || value.content || value.title || value.name || JSON.stringify(value));
  }
  return "";
}

function cleanAnswer(value) {
  return cleanText(stringifyValue(value)).replace(/^["']|["']$/g, "");
}

function scalar(value) {
  const text = cleanText(stringifyValue(value));
  return text.length <= 80 ? text : "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function looksRelevantUrl(url) {
  return /exam|paper|question|quiz|homework|exercise|problem|answer|result|submit|lms|lesson/i.test(url);
}

async function ask(rl, prompt) {
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  return answer;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function logRound(round, stage, result) {
  log(
    `round=${round} stage=${stage} added=${result.added} updated=${result.updated} repeated=${result.repeated}`
  );
}

function log(message) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

/**
 * Fetch the most technically interesting Hacker News stories and generate AI summaries.
 * Outputs JSON to data/stories-YYYY-MM-DD.json
 *
 * Usage: pnpm fetch
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENROUTER_MODEL = 'google/gemini-3-flash-preview';
const TIMEOUT_MS = 60_000;
const STORY_COUNT = Number(process.env.STORY_COUNT ?? 10);
const CANDIDATE_COUNT = Number(process.env.HN_CANDIDATE_COUNT ?? 40);

// ---------------------------------------------------------------------------
// Load API key
// ---------------------------------------------------------------------------

if (!process.env.OPENROUTER_API_KEY) {
  try {
    const devVars = readFileSync('.dev.vars', 'utf-8');
    const match = devVars.match(/OPENROUTER_API_KEY=(.+)/);
    if (match) process.env.OPENROUTER_API_KEY = match[1].trim();
  } catch {
    // handled below
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HNItem {
  id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
  descendants?: number; // comment count
  time: number; // Unix timestamp
  type: string;
}

interface RankedSelection {
  rankedIds: number[];
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: OpenRouterUsage;
}

interface OpenRouterResult {
  id?: string;
  model?: string;
  content: string;
  usage?: OpenRouterUsage;
}

interface SummaryResult {
  summary: SummarySet;
  usage?: OpenRouterUsage;
}

interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

type RequestKind = 'selection' | 'summary';

export interface SummarySet {
  small: string;  // ~20 words
  medium: string; // ~50 words
  large: string;  // ~200 words
}

export interface StorySummary {
  id: number;
  title: string;
  url: string;
  hnUrl: string;
  author: string;
  score: number;
  commentCount: number;
  submittedAt: string; // ISO timestamp
  summary: SummarySet;
}

export interface StoriesData {
  date: string;
  generatedAt: string;
  stories: StorySummary[];
}

const usageTotals: Record<RequestKind | 'overall', UsageTotals> = {
  selection: emptyUsageTotals(),
  summary: emptyUsageTotals(),
  overall: emptyUsageTotals(),
};

// ---------------------------------------------------------------------------
// HN API
// ---------------------------------------------------------------------------

async function fetchTopStories(): Promise<number[]> {
  const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!res.ok) throw new Error(`Failed to fetch top stories: ${res.status}`);
  return res.json();
}

async function fetchItem(id: number): Promise<HNItem> {
  const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
  if (!res.ok) throw new Error(`Failed to fetch item ${id}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

const SUMMARIZER_SYSTEM_PROMPT = `You are a concise news summariser for a Hacker News digest site.

You must produce three summaries of different lengths for each article. Respond with valid JSON only — no markdown fences, no preamble. Use this exact format:

{"small":"...","medium":"...","large":"..."}

- "small": ~20 words. One sentence capturing the core idea.
- "medium": ~50 words. 2–3 sentences with the key insight and context.
- "large": ~200 words. A structured summary using short markdown: start with 1–2 sentences of overview, then use **bold labels** and bullet points (- ) to organise key details. Separate sections with a blank line. Keep bullets concise (one sentence each).

Rules for ALL summaries:
- NEVER include links, URLs, citations, or source references of any kind. No markdown links, no bare URLs, no [source] tags, no (domain.com) references.
- "small" and "medium" must be plain prose only — no bullets, no markdown formatting.
- "large" should use markdown bold (**word**) and bullet lists (- item) for structure.
- Do not include preamble, commentary, or opinions.
- Use British English spelling.`;

const SELECTION_SYSTEM_PROMPT = `You are curating a Hacker News digest for technically sophisticated readers.

Select the stories that are most technically interesting to software engineers, researchers, and technical builders.

Prioritise:
- programming languages, systems, compilers, databases, networking, security, infrastructure, AI/ML engineering, open source, developer tools, hardware, operating systems, research, deep technical write-ups, and technically substantial Show HN posts

Deprioritise:
- current affairs, geopolitics, general business news, product marketing, lifestyle content, purely financial stories, generic opinion pieces, job listings, hiring posts, and stories whose main appeal is non-technical

Respond with valid JSON only using this exact format:
{"rankedIds":[1,2,3]}

Rules:
- Return exactly 10 ids when at least 10 viable candidates are provided
- Rank from most technically interesting to least
- Only use ids from the candidate list
- Do not include commentary or markdown`;

function cleanJsonResponse(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function emptyUsageTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function applyUsageTotals(target: UsageTotals, usage?: OpenRouterUsage) {
  target.requests += 1;
  target.promptTokens += usage?.prompt_tokens ?? 0;
  target.completionTokens += usage?.completion_tokens ?? 0;
  target.totalTokens += usage?.total_tokens ?? 0;
  target.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  target.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
  target.cacheWriteTokens += usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  target.costUsd += usage?.cost ?? 0;
}

function trackUsage(kind: RequestKind, usage?: OpenRouterUsage) {
  applyUsageTotals(usageTotals[kind], usage);
  applyUsageTotals(usageTotals.overall, usage);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatUsageLine(usage?: OpenRouterUsage): string {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;
  const cost = usage?.cost ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;

  const extras: string[] = [];
  if (reasoning > 0) extras.push(`${reasoning} reasoning`);
  if (cached > 0) extras.push(`${cached} cached`);

  return `${formatUsd(cost)} | ${prompt} in / ${completion} out / ${total} total${extras.length ? ` | ${extras.join(', ')}` : ''}`;
}

async function callOpenRouter(
  apiKey: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  kind: RequestKind
): Promise<OpenRouterResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hn-summaries.pages.dev',
        'X-Title': 'HN Summaries',
      },
      body: JSON.stringify({
        model: `${OPENROUTER_MODEL}:online`,
        messages,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    trackUsage(kind, data.usage);

    return {
      id: data.id,
      model: data.model,
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error(`Request timeout (${TIMEOUT_MS}ms)`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

async function summarizeArticle(item: HNItem, apiKey: string): Promise<SummaryResult> {
  const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;

  const prompt = `Fetch and read this article, then summarise it at three lengths. Respond with JSON only.

Title: ${item.title}
URL: ${url}`;

  const result = await callOpenRouter(apiKey, [
    { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 'summary');
  const cleaned = cleanJsonResponse(result.content);
  return {
    summary: JSON.parse(cleaned) as SummarySet,
    usage: result.usage,
  };
}

function extractDomain(url?: string): string {
  if (!url) return 'news.ycombinator.com';

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'news.ycombinator.com';
  }
}

function isLikelyJobPost(item: HNItem): boolean {
  const title = item.title.toLowerCase();
  return (
    /^ask hn:\s*who is hiring/.test(title) ||
    /^who is hiring/.test(title) ||
    /^ask hn:\s*freelancer/.test(title) ||
    /\b(job|jobs|hiring|hire|seeking work|freelance)\b/.test(title)
  );
}

function scoreTechnicalInterestHeuristically(item: HNItem): number {
  const title = item.title.toLowerCase();
  const domain = extractDomain(item.url);

  let score = item.score * 0.35 + (item.descendants ?? 0) * 0.45;

  const positivePatterns = [
    /\b(show hn|ask hn)\b/,
    /\b(ai|llm|ml|compiler|database|postgres|sqlite|linux|kernel|rust|go|python|javascript|typescript|c\+\+|c\b|wasm|webassembly|security|cryptography|gpu|cpu|benchmark|protocol|http|tcp|dns|distributed|kubernetes|docker|terraform|open source|git|vim|emacs|terminal|api|sdk|library|framework|inference|vector|embedding|microcontroller|embedded|rtos|operating system)\b/,
  ];

  const negativePatterns = [
    /\b(trump|president|election|war|ukraine|iran|israel|gaza|china|tariff|senate|congress|court|police|celebrity|sports)\b/,
    /\b(real estate|mortgage|fashion|diet|dating|travel)\b/,
  ];

  for (const pattern of positivePatterns) {
    if (pattern.test(title)) score += 30;
  }

  for (const pattern of negativePatterns) {
    if (pattern.test(title)) score -= 35;
  }

  if (isLikelyJobPost(item)) score -= 1_000;

  if (domain === 'github.com' || domain === 'arxiv.org') score += 20;
  if (item.url == null && !/^show hn:/i.test(item.title) && !/^ask hn:/i.test(item.title)) score -= 15;

  return score;
}

async function selectMostTechnicalStories(items: HNItem[], apiKey: string): Promise<HNItem[]> {
  const filteredItems = items.filter((item) => !isLikelyJobPost(item));
  const itemsById = new Map(filteredItems.map((item) => [item.id, item]));

  const candidateSummary = filteredItems.map((item) => ({
    id: item.id,
    title: item.title,
    domain: extractDomain(item.url),
    url: item.url ?? null,
    score: item.score,
    commentCount: item.descendants ?? 0,
    isShowHN: /^show hn:/i.test(item.title),
    isAskHN: /^ask hn:/i.test(item.title),
  }));

  const prompt = `Choose the ${STORY_COUNT} most technically interesting stories from these Hacker News candidates.

Candidates:
${JSON.stringify(candidateSummary, null, 2)}`;

  let rankedIds: number[] = [];

  try {
    const result = await callOpenRouter(apiKey, [
      { role: 'system', content: SELECTION_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], 'selection');
    console.log(`Technical-interest ranking cost: ${formatUsageLine(result.usage)}`);
    const cleaned = cleanJsonResponse(result.content);
    const parsed = JSON.parse(cleaned) as RankedSelection;
    rankedIds = Array.isArray(parsed.rankedIds) ? parsed.rankedIds : [];
  } catch (error: any) {
    console.warn(`Technical-interest ranking failed, using heuristic fallback: ${error.message}`);
  }

  const selected: HNItem[] = [];
  const usedIds = new Set<number>();

  for (const id of rankedIds) {
    const item = itemsById.get(id);
    if (!item || usedIds.has(id)) continue;
    selected.push(item);
    usedIds.add(id);
    if (selected.length === STORY_COUNT) return selected;
  }

  const fallbackItems = filteredItems
    .filter((item) => !usedIds.has(item.id))
    .sort((a, b) => scoreTechnicalInterestHeuristically(b) - scoreTechnicalInterestHeuristically(a));

  for (const item of fallbackItems) {
    selected.push(item);
    usedIds.add(item.id);
    if (selected.length === STORY_COUNT) break;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadExisting(): StoriesData | null {
  const path = 'data/latest.json';
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY. Add it to .dev.vars');
    process.exit(1);
  }

  // Load existing stories so we can skip ones we've already summarized
  const existing = loadExisting();
  const existingById = new Map<number, StorySummary>();
  if (existing) {
    for (const s of existing.stories) {
      existingById.set(s.id, s);
    }
    console.log(`Loaded ${existingById.size} existing stories from data/latest.json\n`);
  }

  console.log(`Fetching top ${CANDIDATE_COUNT} Hacker News front-page candidates...\n`);

  const topIds = await fetchTopStories();
  const candidateIds = topIds.slice(0, CANDIDATE_COUNT);
  const candidateItems = await Promise.all(candidateIds.map((id) => fetchItem(id)));
  const items = await selectMostTechnicalStories(candidateItems, apiKey);

  console.log(`Selected ${items.length} technically interesting stories from the top ${candidateItems.length} candidates:`);
  for (const item of items) {
    console.log(`  - ${item.title} (${item.score} pts, ${extractDomain(item.url)})`);
  }

  // Determine which stories are new
  const newItems = items.filter((item) => !existingById.has(item.id));
  const reusedItems = items.filter((item) => existingById.has(item.id));

  console.log('');
  for (const item of items) {
    const tag = existingById.has(item.id) ? '(existing)' : '(new)';
    console.log(`  - ${item.title} (${item.score} pts) ${tag}`);
  }

  // Only summarize new stories
  const newSummaries = new Map<number, StorySummary>();
  if (newItems.length > 0) {
    console.log(`\nGenerating summaries for ${newItems.length} new stories...\n`);

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;
      const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;

      console.log(`[${i + 1}/${newItems.length}] ${item.title}`);

      try {
        const result = await summarizeArticle(item, apiKey);
        newSummaries.set(item.id, {
          id: item.id,
          title: item.title,
          url,
          hnUrl,
          author: item.by,
          score: item.score,
          commentCount: item.descendants ?? 0,
          submittedAt: new Date(item.time * 1000).toISOString(),
          summary: result.summary,
        });
        console.log(`  ✓ Done (${formatUsageLine(result.usage)})\n`);
      } catch (err: any) {
        console.error(`  ✗ Error: ${err.message}\n`);
        const fallback = 'Summary unavailable.';
        newSummaries.set(item.id, {
          id: item.id,
          title: item.title,
          url,
          hnUrl,
          author: item.by,
          score: item.score,
          commentCount: item.descendants ?? 0,
          submittedAt: new Date(item.time * 1000).toISOString(),
          summary: { small: fallback, medium: fallback, large: fallback },
        });
      }
    }
  } else {
    console.log('\nNo new stories to summarize.');
  }

  // Build the current digest from only the freshly selected stories.
  const mergedStories: StorySummary[] = [];
  for (const item of items) {
    const story = newSummaries.get(item.id) ?? existingById.get(item.id);
    if (story) {
      // Update score/commentCount to latest values
      mergedStories.push({
        ...story,
        score: item.score,
        commentCount: item.descendants ?? 0,
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const output: StoriesData = {
    date: today,
    generatedAt: new Date().toISOString(),
    stories: mergedStories,
  };

  mkdirSync('data', { recursive: true });
  const filename = `data/stories-${today}.json`;
  writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nWritten ${mergedStories.length} stories to ${filename}`);
  console.log(`  (${newItems.length} new, ${reusedItems.length} updated)`);

  writeFileSync('data/latest.json', JSON.stringify(output, null, 2));
  console.log('Written to data/latest.json');

  console.log('\nGemini cost summary:');
  console.log(`  Selection: ${formatUsd(usageTotals.selection.costUsd)} across ${usageTotals.selection.requests} request(s)`);
  console.log(`  Summaries: ${formatUsd(usageTotals.summary.costUsd)} across ${usageTotals.summary.requests} request(s)`);
  console.log(`  Total: ${formatUsd(usageTotals.overall.costUsd)} across ${usageTotals.overall.requests} request(s)`);
  console.log(`  Tokens: ${usageTotals.overall.promptTokens} in / ${usageTotals.overall.completionTokens} out / ${usageTotals.overall.totalTokens} total`);
  if (usageTotals.overall.reasoningTokens > 0 || usageTotals.overall.cachedTokens > 0) {
    console.log(`  Extras: ${usageTotals.overall.reasoningTokens} reasoning, ${usageTotals.overall.cachedTokens} cached`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

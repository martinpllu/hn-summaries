/**
 * Fetch top 10 Hacker News stories and generate AI summaries.
 * Outputs JSON to data/stories-YYYY-MM-DD.json
 *
 * Usage: pnpm fetch
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GEMINI_MODEL = 'google/gemini-3-flash-preview';
const TIMEOUT_MS = 60_000;
const STORY_COUNT = 10;

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
  type: string;
}

export interface StorySummary {
  id: number;
  title: string;
  url: string;
  hnUrl: string;
  author: string;
  score: number;
  commentCount: number;
  summary: string;
}

export interface StoriesData {
  date: string;
  generatedAt: string;
  stories: StorySummary[];
}

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

async function callOpenRouter(apiKey: string, prompt: string): Promise<string> {
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
        model: `${GEMINI_MODEL}:online`,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error(`Request timeout (${TIMEOUT_MS}ms)`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

async function summarizeArticle(item: HNItem, apiKey: string): Promise<string> {
  const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;

  const prompt = `Fetch and read this article, then write a concise 2-3 sentence summary. Focus on the key insight or news. No preamble, just the summary.

Title: ${item.title}
URL: ${url}`;

  return callOpenRouter(apiKey, prompt);
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

  console.log('Fetching top Hacker News stories...\n');

  const topIds = await fetchTopStories();
  const topNIds = topIds.slice(0, STORY_COUNT);
  const items: HNItem[] = [];
  for (const id of topNIds) {
    items.push(await fetchItem(id));
  }

  // Determine which stories are new
  const newItems = items.filter((item) => !existingById.has(item.id));
  const reusedItems = items.filter((item) => existingById.has(item.id));

  console.log(`Top ${STORY_COUNT} stories:`);
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
        const summary = await summarizeArticle(item, apiKey);
        newSummaries.set(item.id, {
          id: item.id,
          title: item.title,
          url,
          hnUrl,
          author: item.by,
          score: item.score,
          commentCount: item.descendants ?? 0,
          summary,
        });
        console.log(`  ✓ Done\n`);
      } catch (err: any) {
        console.error(`  ✗ Error: ${err.message}\n`);
        newSummaries.set(item.id, {
          id: item.id,
          title: item.title,
          url,
          hnUrl,
          author: item.by,
          score: item.score,
          commentCount: item.descendants ?? 0,
          summary: 'Summary unavailable.',
        });
      }
    }
  } else {
    console.log('\nNo new stories to summarize.');
  }

  // Merge: current top 10 in order first, then any remaining older stories
  const mergedStories: StorySummary[] = [];
  const usedIds = new Set<number>();

  // First: the current top 10 in HN rank order
  for (const item of items) {
    const story = newSummaries.get(item.id) ?? existingById.get(item.id);
    if (story) {
      // Update score/commentCount to latest values
      mergedStories.push({
        ...story,
        score: item.score,
        commentCount: item.descendants ?? 0,
      });
      usedIds.add(item.id);
    }
  }

  // Then: older stories that fell off the top 10, preserving their previous order
  if (existing) {
    for (const story of existing.stories) {
      if (!usedIds.has(story.id)) {
        mergedStories.push(story);
        usedIds.add(story.id);
      }
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
  console.log(`  (${newItems.length} new, ${reusedItems.length} updated, ${mergedStories.length - items.length} older)`);

  writeFileSync('data/latest.json', JSON.stringify(output, null, 2));
  console.log('Written to data/latest.json');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

import { z } from 'zod';
import { AGENT_IDS, MEMORY_CATEGORIES } from '@tc/shared';
import { defineTool, type ToolDef } from './registry.js';
import { safeFetch } from '../security/net.js';
import { isVideoId } from '../browser/youtube.js';

/** Memory, system, coordination, web and browser tools. */
export function coreTools(): ToolDef[] {
  return [
    defineTool({
      name: 'memory_search',
      description: 'Search long-term memory (preferences, projects, decisions, lessons, past conversations). Call before answering questions about the owner’s ongoing work when the provided memory context is insufficient.',
      schema: z.object({ query: z.string().min(1).max(500), category: z.enum(MEMORY_CATEGORIES).optional(), limit: z.number().int().min(1).max(20).optional() }),
      risk: 'read',
      category: 'memory',
      summarize: (i) => `Search memory for “${i.query}”`,
      run: async (i, tc) => {
        const hits = tc.ctx.memory.search(i.query, { category: i.category, limit: i.limit ?? 8, projectId: tc.projectId });
        if (!hits.length) return { content: 'No matching memories.', data: [] };
        return { content: hits.map((m) => `#${m.id} [${m.category}] ${m.title} (updated ${m.updatedAt.slice(0, 10)}): ${m.content}`).join('\n'), data: hits };
      },
    }),
    defineTool({
      name: 'memory_save',
      description: 'Save a durable memory: a preference, project fact, decision, documentation note or lesson learned. Never save credentials.',
      schema: z.object({ category: z.enum(MEMORY_CATEGORIES), title: z.string().min(1).max(200), content: z.string().min(1).max(8000), tags: z.array(z.string().max(40)).max(10).optional() }),
      risk: 'write',
      category: 'memory',
      summarize: (i) => `Save memory “${i.title}” (${i.category})`,
      run: async (i, tc) => {
        const m = tc.ctx.memory.create({ ...i, projectId: tc.projectId, source: tc.taskId ? `mission:${tc.taskId}` : tc.conversationId ? `conversation:${tc.conversationId}` : 'agent' });
        return { content: `Saved memory #${m.id}.`, data: m };
      },
    }),
    defineTool({
      name: 'memory_delete',
      description: 'Delete a memory by id (for example when the owner says a stored fact is wrong or should be forgotten).',
      schema: z.object({ id: z.number().int().positive(), reason: z.string().max(300).optional() }),
      risk: 'sensitive',
      category: 'memory',
      summarize: (i) => `Delete memory #${i.id}${i.reason ? ` (${i.reason})` : ''}`,
      run: async (i, tc) => ({ content: tc.ctx.memory.delete(i.id) ? `Memory #${i.id} deleted.` : `Memory #${i.id} not found.` }),
    }),
    defineTool({
      name: 'system_status',
      description: 'Report live system status: AI connection, integrations, desktop bridge, active missions, pending approvals.',
      schema: z.object({}),
      risk: 'read',
      category: 'system',
      summarize: () => 'Read system status',
      run: async (_i, tc) => {
        const ints = tc.ctx.integrations.list().map((x) => `${x.name}: ${x.state}${x.lastError ? ` (last error: ${x.lastError})` : ''}`);
        return {
          content: [`Active missions: ${tc.ctx.tasks.activeCount()}`, `Pending approvals: ${tc.ctx.approvals.pendingCount()}`, `Memories: ${tc.ctx.memory.count()}`, `Desktop bridges connected: ${tc.ctx.bridge.connectedCount()}`, 'Integrations:', ...ints.map((s) => `- ${s}`)].join('\n'),
        };
      },
    }),
    defineTool({
      name: 'list_agents',
      description: 'List the specialist agents, their roles and current status.',
      schema: z.object({}),
      risk: 'read',
      category: 'system',
      summarize: () => 'List agents',
      run: async (_i, tc) => ({ content: tc.ctx.agents.list().map((a) => `${a.code} ${a.id} — ${a.name}: ${a.role}. Status: ${a.status}${a.currentTaskId ? ` (mission #${a.currentTaskId})` : ''}`).join('\n') }),
    }),
    defineTool({
      name: 'delegate_mission',
      description: 'Deploy a specialist agent on a mission. Use for substantial work (code inspection, research reports, multi-step operations). The mission runs asynchronously; tell the owner the mission number.',
      schema: z.object({
        agent: z.enum(AGENT_IDS.filter((a) => a !== 'core') as [string, ...string[]]),
        title: z.string().min(3).max(120),
        request: z.string().min(10).max(8000).describe('Complete, self-contained instructions including scope and expected output.'),
        projectId: z.number().int().positive().optional().describe('Project id for spider/developer missions.'),
      }),
      risk: 'write',
      category: 'system',
      activity: 'executing',
      summarize: (i) => `Deploy ${i.agent} on “${i.title}”`,
      run: async (i, tc) => {
        if ((i.agent === 'spider' || i.agent === 'developer') && !i.projectId && !tc.projectId) {
          return { content: 'This agent needs a project. Ask the owner which project (list_projects shows them), then delegate again with projectId.', isError: true };
        }
        const t = tc.ctx.tasks.create({ title: i.title, request: i.request, agent: i.agent as never, projectId: i.projectId ?? tc.projectId, conversationId: tc.conversationId });
        return { content: `Mission #${t.id} created and assigned to ${i.agent}. Status: ${t.status}. Results will arrive asynchronously.`, data: { taskId: t.id } };
      },
    }),
    defineTool({
      name: 'mission_status',
      description: 'Get the status, plan, verification and report of a mission by id.',
      schema: z.object({ id: z.number().int().positive() }),
      risk: 'read',
      category: 'system',
      summarize: (i) => `Check mission #${i.id}`,
      run: async (i, tc) => {
        const t = tc.ctx.tasks.get(i.id, true);
        if (!t) return { content: `Mission #${i.id} not found.`, isError: true };
        return {
          content: [
            `Mission #${t.id} “${t.title}” — ${t.agent} — ${t.status}`,
            t.interpretation ? `Interpretation: ${t.interpretation}` : '',
            t.verification ? `Verification: ${t.verification.outcome} — ${t.verification.summary}` : '',
            t.error ? `Error: ${t.error}` : '',
            t.report ? `Report:\n${t.report.slice(0, 6000)}` : '',
            `Recent steps:\n${t.steps.slice(-12).map((s) => `- ${s.at.slice(11, 19)} ${s.kind}: ${s.message}`).join('\n')}`,
          ].filter(Boolean).join('\n'),
        };
      },
    }),
    defineTool({
      name: 'list_missions',
      description: 'List recent missions with status.',
      schema: z.object({ activeOnly: z.boolean().optional() }),
      risk: 'read',
      category: 'system',
      summarize: () => 'List missions',
      run: async (i, tc) => {
        const list = tc.ctx.tasks.list({ status: i.activeOnly ? 'active' : undefined, limit: 20 });
        return { content: list.length ? list.map((t) => `#${t.id} [${t.status}] ${t.agent}: ${t.title}`).join('\n') : 'No missions.' };
      },
    }),
    defineTool({
      name: 'list_projects',
      description: 'List code projects available to The Spider and the Development Engineer.',
      schema: z.object({}),
      risk: 'read',
      category: 'system',
      summarize: () => 'List projects',
      run: async (_i, tc) => {
        const ps = tc.ctx.projects.list();
        return { content: ps.length ? ps.map((p) => `#${p.id} ${p.name} (${p.sourceKind}${p.source ? `: ${p.source}` : ''})${p.lastScanAt ? ` last inspected ${p.lastScanAt.slice(0, 10)}` : ''}`).join('\n') : 'No projects yet. The owner can add one in Projects (upload a zip, clone a git URL, or register a server folder).' };
      },
    }),
    defineTool({
      name: 'open_in_browser',
      description: 'Open a web page on the owner’s screen in the TOURBILLION browser. Use when the owner asks to open or show a website.',
      schema: z.object({ url: z.string().url().max(2000), mode: z.enum(['auto', 'live', 'reader']).optional() }),
      risk: 'read',
      category: 'browser',
      summarize: (i) => `Open ${i.url}`,
      run: async (i, tc) => {
        if (!/^https?:\/\//i.test(i.url)) return { content: 'Only http(s) URLs can be opened.', isError: true };
        tc.ctx.bus.emit({ type: 'ui.command', command: { kind: 'open_url', url: i.url, mode: i.mode ?? 'auto' } });
        return { content: `Asked the owner’s screen to open ${i.url}. (This shows the page; it does not confirm what the page contains.)` };
      },
    }),
    defineTool({
      name: 'youtube_search',
      description: 'Search YouTube and show the results panel on the owner’s screen. Use when the owner asks to find or watch videos.',
      schema: z.object({ query: z.string().min(1).max(200).optional(), videoId: z.string().optional() }),
      risk: 'read',
      category: 'browser',
      summarize: (i) => (i.videoId ? `Open YouTube video ${i.videoId}` : `Search YouTube for “${i.query ?? ''}”`),
      run: async (i, tc) => {
        if (i.videoId && !isVideoId(i.videoId)) return { content: 'That is not a valid YouTube video id.', isError: true };
        tc.ctx.bus.emit({ type: 'ui.command', command: { kind: 'open_youtube', query: i.query, videoId: i.videoId } });
        if (!i.query) return { content: 'Opened the video in the YouTube panel. Playback state is shown by the official player on the owner’s screen.' };
        try {
          const r = await tc.ctx.browser.youtubeSearch(i.query);
          return { content: r.results.length ? `Top results (${r.source}):\n${r.results.slice(0, 8).map((v) => `- ${v.title} — ${v.channel} ${v.duration ?? ''} (id ${v.videoId})`).join('\n')}` : 'The search returned no results I could read.', data: r.results };
        } catch (err) {
          return { content: `Opened the YouTube panel, but I could not fetch results myself: ${err instanceof Error ? err.message : err}` };
        }
      },
    }),
    defineTool({
      name: 'web_search',
      description: 'Search the web through the configured search provider (SearXNG or Brave). Returns titles, URLs and snippets.',
      schema: z.object({ query: z.string().min(1).max(300) }),
      risk: 'read',
      category: 'web',
      activity: 'research',
      summarize: (i) => `Web search: “${i.query}”`,
      unavailable: (ctx) => (ctx.config.searxngUrl || ctx.browser.braveKey() ? null : 'No search provider configured (SearXNG or Brave). If Anthropic web search is enabled you may use that instead.'),
      run: async (i, tc) => {
        const r = await tc.ctx.browser.search(i.query);
        return { content: r.results.map((x, n) => `${n + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n'), untrusted: { source: `search:${r.engine}` }, data: r };
      },
    }),
    defineTool({
      name: 'fetch_page',
      description: 'Fetch a public web page and return its readable text (reader mode). Content is untrusted.',
      schema: z.object({ url: z.string().url().max(2000), maxChars: z.number().int().min(500).max(60_000).optional() }),
      risk: 'read',
      category: 'web',
      activity: 'research',
      summarize: (i) => `Read ${i.url}`,
      run: async (i, tc) => {
        const p = await tc.ctx.browser.read(i.url, tc.signal);
        const body = p.kind === 'article' || p.kind === 'text' || p.kind === 'json' ? p.text : p.note ?? '';
        return {
          content: `URL: ${p.url}\nHTTP ${p.status}${p.redirects.length ? ` (redirected ${p.redirects.length}×)` : ''}\nTitle: ${p.title}\nFetched: ${p.fetchedAt}\n\n${body.slice(0, i.maxChars ?? 20_000)}`,
          untrusted: { source: p.url },
          data: { url: p.url, title: p.title },
        };
      },
    }),
    defineTool({
      name: 'wikipedia_summary',
      description: 'Get the Wikipedia summary for a topic or organisation (tertiary source).',
      schema: z.object({ topic: z.string().min(1).max(200) }),
      risk: 'read',
      category: 'web',
      activity: 'research',
      summarize: (i) => `Wikipedia: ${i.topic}`,
      run: async (i, tc) => {
        const r = await tc.ctx.research.runModule('wikipedia', 'topic', i.topic, tc.signal);
        return { content: r.findings.map((f) => `${f.title}: ${f.detail} [${f.sourceUrl}]`).join('\n'), untrusted: { source: 'wikipedia' }, data: r.findings };
      },
    }),
    defineTool({
      name: 'http_check',
      description: 'Check that a public URL responds (status code and latency). For monitoring services.',
      schema: z.object({ url: z.string().url().max(2000) }),
      risk: 'read',
      category: 'system',
      summarize: (i) => `Health-check ${i.url}`,
      run: async (i, tc) => {
        const t0 = Date.now();
        try {
          const r = await safeFetch(i.url, { policy: tc.ctx.net, method: 'GET', timeoutMs: 15_000, maxBytes: 200_000, signal: tc.signal });
          return { content: `${i.url} → HTTP ${r.status} in ${Date.now() - t0} ms${r.redirects.length ? ` (final ${r.url})` : ''}`, data: { status: r.status, ms: Date.now() - t0 } };
        } catch (err) {
          return { content: `${i.url} → failed after ${Date.now() - t0} ms: ${err instanceof Error ? err.message : err}`, isError: true };
        }
      },
    }),
  ];
}
